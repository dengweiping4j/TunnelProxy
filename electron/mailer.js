// 异常告警邮件：转发服务掉线时给指定邮箱发一封通知。
// 设计原则和 logger 一致：只做加法——发送失败只记日志，绝不抛异常打断主流程。
const nodemailer = require('nodemailer')

// SMTP 配置（改这里即可换邮箱服务）
const MAIL_CONFIG = {
  host: 'smtp.163.com',
  port: 25,
  // nodemailer 用 auth.user / auth.pass，对应 Spring 风格配置里的 username / password
  auth: {
    user: 'tool4j@163.com',
    pass: 'SGJFJVQOIUALVLOD'
  }
}

// 告警收件人
const ALERT_TO = 'weipingdeng@qq.com'

// transporter 懒创建并复用：不发邮件时零开销，发了之后连接也可以复用
let transporter = null

const getTransporter = () => {
  if (!transporter) {
    transporter = nodemailer.createTransport(MAIL_CONFIG)
  }
  return transporter
}

// 发一封告警邮件，返回是否发送成功（失败不抛异常，由调用方决定是否重试）
const sendAlert = async ({ subject, text }) => {
  try {
    await getTransporter().sendMail({
      from: MAIL_CONFIG.auth.user, // 发件人必须和登录账号一致，163 才认
      to: ALERT_TO,
      subject,
      text
    })
    console.log(`告警邮件已发送: ${subject}`)
    return true
  } catch (err) {
    console.error(`告警邮件发送失败: ${err.message}`)
    return false
  }
}

module.exports = { sendAlert, ALERT_TO }
