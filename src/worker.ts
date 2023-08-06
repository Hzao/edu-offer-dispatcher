import { KJUR, KEYUTIL } from 'jsrsasign';
import { DateTime } from 'luxon';


export interface Env {
	// If you set another name in wrangler.toml as the value for 'binding',
	// replace "DB" with the variable name you defined.
	DB: D1Database;
	AS_SECRET_KEY: string;
	JWT_KID: string;
	JWT_ISS: string;
	OFFERCODE_ID: string;
	RESEND_APIKEY: string;
	EMAILWORKER_AUTHKEY: string;
	FEISHU_ROBOT_URL: string;
}

function createJWT(JWT_KID: String, JWT_ISS: String, AS_SECRET_KEY: String) {
	const sHeader = JSON.stringify({ alg: 'ES256', kid: JWT_KID, typ: 'JWT' });
	const oPayload = {
		"iss": JWT_ISS,
		"iat": Math.floor(Date.now() / 1000),
		"exp": Math.floor(Date.now() / 1000) + 60,
		"aud": "appstoreconnect-v1"
	};
	const prvKey = KEYUTIL.getKey(AS_SECRET_KEY);
	return KJUR.jws.JWS.sign('ES256', sHeader, oPayload, prvKey);
}

async function getCodesAndSaveToDB(env: Env) {
	const JWT_token = createJWT(env.JWT_KID, env.JWT_ISS, env.AS_SECRET_KEY);
	const expirationDate = DateTime.now().plus({ days: 177 }).toFormat('yyyy-MM-dd');

	try {
		const body = {
			data: {
				attributes: {
					expirationDate,
					numberOfCodes: 500,
				},
				relationships: {
					offerCode: {
						data: {
							id: env.OFFERCODE_ID,
							type: 'subscriptionOfferCodes',
						},
					},
				},
				type: 'subscriptionOfferCodeOneTimeUseCodes',
			}
		};

		const createCodeResponse = await fetch('https://api.appstoreconnect.apple.com/v1/subscriptionOfferCodeOneTimeUseCodes', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${JWT_token}`
			},
			body: JSON.stringify(body)
		});
		if (!createCodeResponse.ok) {
			throw new Error(`Received a non-OK HTTP status code when creating codes: ${createCodeResponse.status}`);
		}

		const data = await createCodeResponse.json();
		const codeLink = data.data.relationships.values.links.related;
		const getLinkPrefix = 'https://api.appstoreconnect.apple.com/v1/subscriptionOfferCodeOneTimeUseCodes/';
		if (!codeLink.startsWith(getLinkPrefix)) {
			throw new Error("OfferCode get URL didn't start with " + getLinkPrefix);
		}


		const getCodeResponse = await fetch(codeLink, {
			method: 'GET',
			headers: {
				'Authorization': `Bearer ${JWT_token}`,
				'Accept': `text/csv`
			}
		});

		const getCodeResponseBody = await getCodeResponse.text();
		if (!getCodeResponse.ok) {
			throw new Error(`Received a non-OK HTTP status code when fetching codes: ${createCodeResponse.status}`);
		}
		const lines = getCodeResponseBody.split('\n');



		const statements = [];
		const creation_date = new Date().toISOString();
		for (let line of lines) {
			const [code] = line.split(',');
			if (code.length > 1) {
				statements.push(
					env.DB.prepare(`
              INSERT INTO RedeemCodes (code, creation_date, expiry_date)
              VALUES (?, ?, ?)`)
						.bind(code, creation_date, expirationDate)
				);
			}
		}
		if (statements.length > 0) {
			await env.DB.batch(statements);
		}


	} catch (error) {
		console.error(`Unable to get codes: ${error}`);
		throw error
	}
}


async function redeemCode(emailAddress: string, env: Env) {
	// 检查过去一年用户是否已兑换过
	const oneYearAgo = DateTime.local().minus({ years: 1 }).toISO();
	const checkResult = await env.DB.prepare(`
		SELECT * FROM RedeemCodes 
		WHERE issued_to = ? AND issue_date >= ? AND is_redeemed = 1`)
		.bind(emailAddress, oneYearAgo)
		.all();

	const nowPlusSevenDays = DateTime.local().plus({ days: 7 }).toISO();

	if (checkResult.success != true) {
		throw new Error('Error querying record from the past 1 year.');
	}
	if (checkResult.results.length > 0) {
		console.log('Redeemd within a year.');
		const lastRedeemDate = checkResult.results[0].issue_date as string;
		await sendExceedLimitEmail(emailAddress, lastRedeemDate, env);
		return;
	}


	// 获取一个有效而且未发放的兑换码
	let getResult = await env.DB.prepare(`
        SELECT * FROM RedeemCodes 
        WHERE expiry_date > ? AND (issued_to IS NULL OR issued_to = '') AND is_redeemed = 0 
        LIMIT 1`)
		.bind(nowPlusSevenDays)
		.all();
	if (getResult.success != true) {
		throw new Error('Error querying record for valid offer codes.');
	}

	if (!(getResult.results.length > 0)) {
		console.log('didnt find result so generating new ones.');
		await getCodesAndSaveToDB(env);
		getResult = await env.DB.prepare(`
        SELECT * FROM RedeemCodes 
        WHERE expiry_date > ? AND (issued_to IS NULL OR issued_to = '') AND is_redeemed = 0 
        LIMIT 1`)
			.bind(nowPlusSevenDays)
			.all();
		if (getResult.success != true) {
			throw new Error('Error querying record for valid offer codes.');
		}
	}
	if (!(getResult.results.length > 0)) {
		throw new Error('No available redeem code.');
	}
	const code = getResult.results[0].code as string;
	const expiryDate = getResult.results[0].expiry_date as string;
	const now = DateTime.local().toISO();
	await env.DB.prepare(`
        UPDATE RedeemCodes 
        SET issue_date = ?, issued_to = ?, is_redeemed = 1 
        WHERE code = ?`)
		.bind(now, emailAddress, code).run();
	await sendCodeEmail(emailAddress, code, expiryDate, env);
}

export default {
	async fetch(request: Request, env: Env) {
		console.log('------');
		const { pathname } = new URL(request.url);
		if (request.headers.get('Authorization') != env.EMAILWORKER_AUTHKEY) {
			console.log("Authtication failed.");
			return new Response("Not authorized.", {
				status: 400
			})
		}
		const result = await request.json();
		const receiverAddress = result?.receiverAddress;

		try {
			if (!receiverAddress || typeof receiverAddress !== "string") {
				// 如果无法在请求体中找到“receiverAddress”字段。
				throw new Error("No Receiver Address Found. JSON:" + request.json);
			}

			let eduSuffixes = ["bupt.cn", ".edu", ".edu.cn", ".edu.au", ".ac.uk", ".edu.sg", ".ac.jp", ".edu.hk", ".edu.tw", ".edu.in", ".ac.kr", ".edu.za", ".edu.br", ".edu.mx", ".edu.my", ".edu.ph", ".edu.pk", ".edu.pl", ".edu.ru", ".ac.th", ".edu.tr", ".edu.eg", ".edu.ng", ".edu.vn", ".edu.pe", ".edu.sa", ".edu.uy", ".edu.es", ".edu.fr", ".edu.it", ".edu.de"];
			let isEducational = eduSuffixes.some(suffix => receiverAddress.endsWith(suffix));
			console.log('Address:' + receiverAddress);
			console.log('isEducational:' + isEducational);
			// return;
			if (!isEducational) {
				await sendNotEligibleEmail(receiverAddress, env);
				return new Response("", {
					status: 200
				})
			}

			await redeemCode(receiverAddress, env);
		} catch (error) {
			console.log("Notifying developer:");
			console.log('---' + error.message);
			await notifyDeveloperOfError(env.FEISHU_ROBOT_URL, error.message, receiverAddress ?? "null");
			if (receiverAddress && typeof receiverAddress == "string") {
				await sendTechnicalIssueEmail(receiverAddress, env);
			}
			return new Response('Error sending offercode: ' + error.message,
				{
					status: 400
				}
			);
		}

		return new Response("Succeed", {
			status: 200
		})
	},
};




//Email Related
//以下几个变量会被用于替换模板内容，向用户等发送邮件通知。
const appName = "Numpkin" //app 的名称，如 Numpkin
const serviceName = "Numpkin Pro" // 要给予教育优惠的服务名称
const contactEmail = "john@example.com" //用于联系你的邮箱，如 Numpkin 支持的联系邮箱是 hi@numpkin.app
const redeemPath = "Numpkin 设置 -> 订阅 Numpkin Pro -> 兑换代码。"// 告知用户在哪里使用你的兑换代码
//senderEmail:给用户发送邮件的发信人。请让该发信人与你在 Resend 中绑定的域名相符。例如在 Resend 中绑定了 mail.numpk.in
//那么就可以填写 noreply@mail.numpk.in
const senderEmail = "noreply@example.com" 

async function sendTechnicalIssueEmail(emailAddress: string, env: Env) {
	const emailHTML = `<!DOCTYPE html>
	<html>
	<head>
		<meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<style>
			body {
				font-family: Arial, sans-serif;
				margin: 0;
				padding: 0;
			}
			.container {
				padding: 20px;
			}
			.footer {
				font-size: 0.8em;
				color: grey;
			}
		</style>
	</head>
	<body>
		<div class="container">
			<p>亲爱的用户，</p>
			<p>感谢你对 ${serviceName} 教育优惠的关注。</p>
			<p>很抱歉，由于我们的优惠码生成过程出现了技术问题，我们暂时无法为你提供优惠代码。${appName} 的开发者已经被通知此问题并且正在处理。</p>
			<p>请放心，你应该会很快收到我们手动发送的优惠代码。如果在稍后的时间还没有收到，请再尝试一次或者通过以下地址联系 ${appName} 支持：</p>
			<p><strong><a href="mailto:${contactEmail}">${contactEmail}</a></strong></p>
			<p>对给你带来的不便，我们感到非常抱歉。</p>
			<p>祝你旅行、聚会愉快！</p>
			<p>最诚挚的问候，<br>${appName} 支持</p>
		</div>
		<div class="container footer">
			<hr>
			<p>请不要回复此邮件，因为这是自动发出的。如果你有任何问题，可以通过电子邮件联系我们：<a href="mailto:${contactEmail}">${contactEmail}</a></p>
		</div>
	</body>
	</html>
	`;

	await sendEmail(emailAddress, "有关你的 ${serviceName} 教育优惠申请（技术问题）", emailHTML, env);
}

async function sendExceedLimitEmail(emailAddress: string, lastApplyDate: string, env: Env) {
	let date = new Date(Date.parse(lastApplyDate));

	let year = date.getFullYear();
	let month = date.getMonth() + 1;
	let day = date.getDate();

	let newDateString = `${year}年${month}月${day}日`;
	console.log('email:' + emailAddress);
	console.log('lastAD:' + lastApplyDate);
	console.log('email:' + emailAddress);
	console.log('newDateString:' + newDateString);
	const emailHTML = `<!DOCTYPE html>
	<html>
	<head>
		<meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<style>
			body {
				font-family: Arial, sans-serif;
				margin: 0;
				padding: 0;
			}
			.container {
				padding: 20px;
			}
			.footer {
				font-size: 0.8em;
				color: grey;
			}
		</style>
	</head>
	<body>
		<div class="container">
			<p>亲爱的用户，</p>
			<p>感谢你对 ${serviceName} 教育优惠的关注。</p>
			<p>很抱歉，我们注意到你在过去的一年内已经获取过教育优惠。因此，你暂时不能重新获取优惠代码。</p>
			<p>你上次获取教育优惠的时间是${newDateString}。请在距离上次获得教育优惠 1 年后再尝试获取。</p>
			<p>在此期间，你仍然可以享受 ${serviceName} 的众多精彩功能。</p>
			<p>如果你认为我们的判断有误，即你未在过去的 1 年内获取过教育优惠，请通过以下电子邮件地址联系我们，我们会尽快对此进行核查并提供相应的帮助：</p>
			<p><strong><a href="mailto:${contactEmail}">${contactEmail}</a></strong></p>
			<p>祝你旅行、聚会愉快！</p>
			<p>最诚挚的问候，<br>${appName} 支持</p>
		</div>
		<div class="container footer">
			<hr>
			<p>请不要回复此邮件，因为这是自动发出的。如果你有任何问题，可以通过电子邮件联系我们：<a href="mailto:${contactEmail}">${contactEmail}</a></p>
		</div>
	</body>
	</html>
	`;
	console.log('sending ReDeemed Within A Year Email');
	await sendEmail(emailAddress, `你曾在 1 年内申请过 ${serviceName} 教育优惠`, emailHTML, env);
}


async function sendNotEligibleEmail(emailAddress: string, env: Env) {
	const emailHTML = `<!DOCTYPE html>
	<html>
	<head>
		<meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<style>
			body {
				font-family: Arial, sans-serif;
				margin: 0;
				padding: 0;
			}
			.container {
				padding: 20px;
			}
			.footer {
				font-size: 0.8em;
				color: grey;
			}
		</style>
	</head>
	<body>
		<div class="container">
			<p>亲爱的用户，</p>
			<p>感谢你尝试获取 ${serviceName} 教育优惠。</p>
			<p>很抱歉，我们发现你的电子邮件地址 ${emailAddress} 不符合我们的教育优惠要求。</p>
			<p>教育优惠只适用于有效的教育机构的邮箱。如果你认为我们的判断有误，即你的邮箱确实是教育邮箱，请通过以下电子邮件地址联系我们，我们会尽快对此进行核查并提供相应的帮助：</p>
			<p><strong><a href="mailto:${contactEmail}">${contactEmail}</a></strong></p>
			<p>感谢你对 ${appName} 的支持。</p>
			<p>最诚挚的问候，<br>${appName} 支持</p>
		</div>
		<div class="container footer">
			<hr>
			<p>请不要回复此邮件，因为这是自动发出的。如果你有任何问题，可以通过电子邮件联系我们：<a href="mailto:${contactEmail}">${contactEmail}</a></p>
		</div>
	</body>
	</html>
	`;
	await sendEmail(emailAddress, `有关你的 ${serviceName} 教育优惠资格`, emailHTML, env);
}

async function sendCodeEmail(emailAddress: string, code: string, expirationDate: string, env: Env) {
	let date = new Date(Date.parse(expirationDate));

	let year = date.getFullYear();
	let month = date.getMonth() + 1;
	let day = date.getDate();

	let newDateString = `${year}年${month}月${day}日`;

	const emailHTML = ` <!DOCTYPE html>
	<html>
	<head>
		<meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<style>
			body {
				font-family: Arial, sans-serif;
				margin: 0;
				padding: 0;
			}
			.container {
				padding: 20px;
			}
			.footer {
				font-size: 0.8em;
				color: grey;
			}
		</style>
	</head>
	<body>
		<div class="container">
			<p>亲爱的用户，</p>
			<p>感谢你获取 ${serviceName} 教育优惠，以下是你的教育优惠代码：</p>
			<p><strong>${code}</strong></p>
			<p>有效截止日期为${newDateString}。请在截止日期之前兑换。</p>
			<p>你可以按照以下路径进行兑换：</p>
			<p>${redeemPath}</p>
			<p>祝你生活愉快！</p>
			<p>最诚挚的问候，<br>${appName} 支持</p>
		</div>
		<div class="container footer">
			<hr>
			<p>请不要回复此邮件，因为这是自动发出的。如果你有任何问题，可以通过电子邮件联系我们：<a href="mailto:${contactEmail}">${contactEmail}</a></p>
		</div>
	</body>
	</html>
	`;

	await sendEmail(emailAddress, `你的 ${serviceName} 教育优惠`, emailHTML, env);
}




async function sendEmail(to: String, subject: String, html: String, env: Env) {
	console.log("Email Sent To");
	console.log(to);

	console.log("Subject");
	console.log(subject);


	try {
		const request = await fetch('https://api.resend.com/emails', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${env.RESEND_APIKEY}`,
			},
			body: JSON.stringify({
				from: `${appName} <${senderEmail}>`,
				to: [to],
				subject: subject,
				html: html,
			}),
		});
	} catch (error) {
		console.log('error');
		console.log(error.message);
		throw new Error("Error Sending Email:" + error.message);
	}

	console.log('response constructed');
	return new Response("Succeed", {
		status: 200
	})

	/**
	 * gatherResponse awaits and returns a response body as a string.
	 * Use await gatherResponse(..) in an async function to get the response body
	 * @param {Response} response
	 */
	async function gatherResponse(response) {
		const { headers } = response;
		const contentType = headers.get('content-type') || '';
		if (contentType.includes('application/json')) {
			return JSON.stringify(await response.json());
		}
		return response.text();
	}
}



//Feishu Notification

async function notifyDeveloperOfError(endPoint: string, message: string, mailAddress: string) {
	const currentTime = new Date()
	const timeZoneOffset = 8 * 60 * 60 * 1000 // 时区偏移量，东八区为 8 * 60 * 60 * 1000 毫秒
	const currentTimeCST = new Date(currentTime.getTime() + timeZoneOffset)
	const timeString = currentTimeCST.toISOString().replace(/T/, ' ').replace(/\..+/, '')


	// 构建飞书机器人的payload
	const feishuPayload = {
		msg_type: 'interactive',
		card: {
			elements: [
				{
					tag: 'markdown',
					content: `**错误信息**: ${message}`
				},
				{
					tag: 'markdown',
					content: `**请求的邮件地址**: ${mailAddress}`
				},
				{
					tag: 'markdown',
					content: `**时间**: ${timeString}`
				}
			],
			header: {
				template: 'blue',
				title: {
					content: `服务出现问题 - ${appName} 教育优惠分发`,
					tag: 'plain_text'
				}
			}
		}
	}

	// 发送请求到飞书机器人
	const response = await fetch(endPoint, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(feishuPayload)
	})
}