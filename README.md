# edu-offer-dispatcher
A serverless project that helps iOS developers automatically distribute educational discounts through email.

这是一个主要由 Cloudflare Worker 完成的，通过邮件验证教育资格并分发优惠代码的系统，可以直接用于 Apple 生态开发者支持教育优惠。

特性：

- 通过教育邮箱验证资格：接收邮件，如果来信地址是教育邮箱，则向其发送优惠代码。要保证发送的代码还剩至少 7 天的有效期。

- 一次部署，尽量零维护：接入 App Store Connect API，优惠代码用完了之后，自动获取新的并保存到数据库。App Store 一次最低允许生成 500 个优惠代码，因此需要一次生成后，把所有代码保存起来。

- 频率限制：例如，同一个邮件地址每年只允许获取一次教育优惠。

- 错误通知与处理：如果用户因为资格不符或超过频率限制，发邮件通知用户；如果程序抛出异常，则告知用户程序出错，让其耐心等待开发者修复，同时通知开发者这个异常，方便及时修复并手动重发优惠代码。

- 简单低成本：使用 Cloudflare Worker，不配置服务器，免费额度足够涵盖绝大多数需求。

  

请配合博客 [让你的 iOS App 支持教育优惠（上）：获取配置变量](https://blog.hzao.top/2023/08/06/enabling-your-ios-app-to-support-educational-discounts-for-obtaining-configuration-variables-part-1) 、[让你的 iOS App 支持教育优惠（下）：部署和测试](https://blog.hzao.top/2023/08/06/enabling-your-ios-app-to-support-educational-discounts-for-obtaining-configuration-variables-part-2) 使用。

## 限制

原作者没有 TypeScript 的开发经验，所有代码都由 GPT 生成，经由人工修改。可能有一些语法上的问题（其实现在也有很多没解决的编译器报错），如果可以优化，欢迎指出。

## 免责声明

上述博客分享的所有步骤和代码都是公开的，尽管原作者已尽量保证安全性，但仍然可能存在没有预见的隐患。请阅读代码并理解各个步骤，自行判断得失、合规性、安全性后再部署。作者和贡献者不对因此带来的任何风险和事故负任何责任。
