export default {
  async email(message, env, ctx) {
  let receiverAddress = message.from;
  let url = 'https://xxxx.xxxxxxx.workers.dev'
  let init = {
    method: 'POST',
    headers: {
      'Authorization': `xxxxxxxxxxxxxxxxxxxxxxx`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      receiverAddress
    })
  };

  await message.forward("xxxx@gmail.com");
  let res = await fetch(url, init);


  }
}
