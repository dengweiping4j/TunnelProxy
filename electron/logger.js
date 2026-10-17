// 主进程文件日志：按天归档到 LOG_DIR。
// 设计原则：只做加法——日志目录不可写、写盘失败、积压等情况一律降级为「不写文件」，
// 绝不抛异常打断转发 / SSH 流程。
const fs = require('fs')
const path = require('path')

// 日志目录（改这里即可换位置），不可写时退回 fallbackDir（userData/logs）
const LOG_DIR = 'D:\\TunnelProxy\\logs'
// 写缓冲超过该阈值就先丢弃新日志，避免极端流量下内存被日志撑大
const MAX_BUFFERED = 4 * 1024 * 1024

let enabled = false
let logDir = null
let stream = null
let streamDate = null
let dropped = 0
let installing = false
let installed = false

const pad = (n, len = 2) => String(n).padStart(len, '0')

const datePart = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

const timePart = (d) =>
  `${datePart(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`

const formatBytes = (n) => {
  if (!n || n < 0) return '0B'
  if (n < 1024) return `${n}B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)}KB`
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)}MB`
  return `${(n / 1073741824).toFixed(2)}GB`
}

const formatArg = (a) => {
  if (typeof a === 'string') return a
  if (a instanceof Error) return a.stack || a.message
  try {
    return JSON.stringify(a)
  } catch (_) {
    return String(a)
  }
}

const disable = (reason) => {
  if (!enabled) return
  enabled = false
  try { stream && stream.end() } catch (_) {}
  stream = null
  console.error(`文件日志已停用: ${reason}`)
}

// 每天一个文件：requests-YYYY-MM-DD.log
const ensureStream = () => {
  const today = datePart(new Date())
  if (stream && streamDate === today) return stream
  try {
    if (stream) {
      stream.end()
      stream = null
    }
    stream = fs.createWriteStream(path.join(logDir, `requests-${today}.log`), { flags: 'a' })
    streamDate = today
    stream.on('error', (err) => disable(`写入失败 ${err.message}`))
  } catch (err) {
    disable(`创建日志文件失败 ${err.message}`)
  }
  return stream
}

// tag: REQ(请求记录) / RETRY(重连) / LOG / 以及转发的 console 输出(INFO/WARN/ERROR)
const write = (tag, message) => {
  if (!enabled) return
  const s = ensureStream()
  if (!s) return
  if (s.writableLength > MAX_BUFFERED) {
    dropped++
    return
  }
  try {
    const line = `${timePart(new Date())} [${tag}] ${message}\n`
    s.write(dropped > 0 ? `${timePart(new Date())} [LOG] 写入积压，已丢弃 ${dropped} 条日志\n${line}` : line)
    dropped = 0
  } catch (err) {
    disable(`写入异常 ${err.message}`)
  }
}

// 一条请求记录（连接结束时调用，字段取自 socket 自带的计数器，零额外开销）
const request = ({ type, id, peer, target, ms, up, down, reason }) => {
  write(
    'REQ',
    `${type === 'reverse-ssh' ? '反向' : '正向'} ${id} | ${peer} -> ${target} | ${ms}ms | 上行 ${formatBytes(up)} 下行 ${formatBytes(down)} | ${reason}`
  )
}

const lifecycle = (message) => write('RETRY', message)

// 把主进程已有的 console 输出一并落盘，避免为了记日志去改一堆调用点
const installConsoleTee = () => {
  if (installed || installing) return
  installing = true
  const tee = (level, original) => {
    return (...args) => {
      try { original.apply(console, args) } catch (_) {}
      if (!enabled) return
      try {
        write(level, args.map(formatArg).join(' '))
      } catch (_) {}
    }
  }
  const raw = { log: console.log, warn: console.warn, error: console.error }
  console.log = tee('INFO', raw.log.bind(console))
  console.warn = tee('WARN', raw.warn.bind(console))
  console.error = tee('ERROR', raw.error.bind(console))
  installed = true
  installing = false
}

const init = ({ fallbackDir } = {}) => {
  for (const dir of [LOG_DIR, fallbackDir].filter(Boolean)) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      logDir = dir
      enabled = true
      break
    } catch (err) {
      console.error(`日志目录不可用: ${dir} (${err.message})`)
    }
  }
  installConsoleTee()
  if (enabled) {
    write('LOG', `日志启动，按天归档，目录: ${logDir}`)
  } else {
    console.error('文件日志已禁用：没有可写的日志目录')
  }
  return enabled
}

module.exports = { init, write, request, lifecycle, formatBytes, LOG_DIR, getDir: () => logDir }
