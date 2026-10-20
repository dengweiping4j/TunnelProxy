const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron')
const path = require('path')
const net = require('net')
const { spawn } = require('child_process')
const fs = require('fs')
const { Client } = require('ssh2')
const Store = require('electron-store')
const logger = require('./logger')
const mailer = require('./mailer')

// 提前设置单实例锁，避免二次实例瞬退导致“自动退出”的错觉
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  try { app.quit() } catch (_) {}
  try { process.exit(0) } catch (_) {}
} else {
  app.on('second-instance', () => {
    try {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show()
        mainWindow.focus()
      }
    } catch (e) {
      console.error('激活已有实例失败:', e)
    }
  })
}

// 主进程增加基础错误日志，避免因未捕获异常直接退出
process.on('uncaughtException', (error) => {
  try {
    console.error('主进程未捕获的异常:', error)
  } catch (_) {}
})
process.on('unhandledRejection', (reason) => {
  try {
    console.error('主进程未处理的 Promise 拒绝:', reason)
  } catch (_) {}
})

// 设置应用程序名称
app.setName('Tunnel Proxy')

// 配置应用缓存路径
app.setPath('userData', path.join(app.getPath('appData'), 'port-forwarder'))

// 初始化 store
const store = new Store({
  name: 'port-forwarding-rules',
  defaults: {
    forwardings: []
  }
});

// 初始化文件日志（目录见 electron/logger.js 的 LOG_DIR；不可写时退回 userData/logs）
logger.init({ fallbackDir: path.join(app.getPath('userData'), 'logs') });

let mainWindow
let tray = null
const forwardingServers = new Map()
const reverseSshProcesses = new Map()
const sshClients = new Map()

// 断线重连阶梯：第 1 次 1 分钟，之后 5 / 10 / 30 分钟，登顶后一直按 30 分钟重试
const RETRY_LADDER_MINUTES = [1, 5, 10, 30]
// 用固定周期 tick 检查到期，而不是挂一串长定时器：休眠唤醒后漏掉的计划也不会丢
const RETRY_TICK_MS = 30 * 1000
const retryQueue = new Map() // id -> { attempts, nextAt }
let retryTimer = null

// 获取资源路径的统一函数
const getResourcePath = (...pathSegments) => {
  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged
  
  if (isDev) {
    // 开发环境：从 src/assets 或 resources 目录获取
    const devPath1 = path.join(__dirname, '../src/assets', ...pathSegments)
    const devPath2 = path.join(__dirname, '../resources', ...pathSegments)
    
    // 检查文件是否存在，优先使用 src/assets
    if (fs.existsSync(devPath1)) {
      return devPath1
    } else if (fs.existsSync(devPath2)) {
      return devPath2
    } else {
      // 兜底路径
      return devPath1
    }
  } else {
    // 生产环境：从 process.resourcesPath 获取
    return path.join(process.resourcesPath, ...pathSegments)
  }
}

// 创建系统托盘
const createTray = () => {
  // 获取托盘图标路径
  const getTrayIconPath = () => {
    if (process.platform === 'win32') {
      return getResourcePath('icons', '32x32.png')
    } else if (process.platform === 'darwin') {
      return getResourcePath('icons', '16x16.png')
    } else {
      return getResourcePath('icons', '32x32.png')
    }
  }

  const iconPath = getTrayIconPath()
  console.log('托盘图标路径:', iconPath)
  console.log('图标文件是否存在:', fs.existsSync(iconPath))
  
  // 创建托盘图标
  tray = new Tray(iconPath)
  
  // 设置托盘提示文本
  tray.setToolTip('Tunnel Proxy - 端口转发工具')
  
  // 创建托盘右键菜单
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => {
        if (mainWindow) {
          if (mainWindow.isMinimized()) {
            mainWindow.restore()
          }
          mainWindow.show()
          mainWindow.focus()
        }
      }
    },
    {
      label: '隐藏到托盘',
      click: () => {
        if (mainWindow) {
          mainWindow.hide()
        }
      }
    },
    { type: 'separator' },
    {
      label: '转发规则管理',
      click: () => {
        if (mainWindow) {
          mainWindow.show()
          mainWindow.focus()
        }
      }
    },
    { type: 'separator' },
    {
      label: '关于',
      click: () => {
        if (mainWindow) {
          mainWindow.webContents.executeJavaScript(`
            alert('Tunnel Proxy v${require('../package.json').version}\\n\\n一个简单易用的端口转发工具\\n支持本地转发和SSH反向转发');
          `)
          mainWindow.show()
          mainWindow.focus()
        }
      }
    },
    {
      label: '退出程序',
      click: () => {
        app.isQuiting = true
        app.quit()
      }
    }
  ])
  
  // 设置托盘菜单
  tray.setContextMenu(contextMenu)
  
  // 双击托盘图标显示主窗口
  tray.on('double-click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide()
      } else {
        mainWindow.show()
        mainWindow.focus()
      }
    }
  })
  
  // 单击托盘图标（Windows 下）
  tray.on('click', () => {
    if (process.platform === 'win32') {
      if (mainWindow) {
        if (mainWindow.isVisible()) {
          mainWindow.hide()
        } else {
          mainWindow.show()
          mainWindow.focus()
        }
      }
    }
  })
}

const createWindow = () => {
  // 获取图标路径
  const getIconPath = () => {
    if (process.platform === 'win32') {
      return getResourcePath('icons', 'icon.ico')
    } else if (process.platform === 'darwin') {
      return getResourcePath('icons', 'icon.icns')
    } else {
      return getResourcePath('icons', '512x512.png')
    }
  }

  const iconPath = getIconPath()
  console.log('主窗口图标路径:', iconPath)
  console.log('主窗口图标文件是否存在:', fs.existsSync(iconPath))

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: iconPath,
    autoHideMenuBar:true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: true,
      preload: path.join(__dirname, 'preload.js'),
      // 添加缓存配置
      partition: 'persist:main'
    },
    show: false,
    backgroundColor: '#fff',
    // 添加窗口标题
    title: 'Tunnel Proxy',
  })

  // 配置 session
  const ses = mainWindow.webContents.session
  ses.clearCache()
    .then(() => {
      console.log('清除缓存成功');
    })
    .catch(err => {
      console.error('清除缓存失败:', err);
    });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  // 拦截窗口关闭事件
  mainWindow.on('close', (event) => {
    if (!app.isQuiting) {
      event.preventDefault()
      mainWindow.hide()
      
      // 首次隐藏时显示提示（可选）
      if (!mainWindow.hasShownTrayNotification) {
        tray.displayBalloon({
          iconType: 'info',
          title: 'Tunnel Proxy',
          content: '应用程序已最小化到系统托盘，点击托盘图标可以重新打开'
        })
        mainWindow.hasShownTrayNotification = true
      }
      return false
    }
  })

  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged
  const devUrl = process.env.VITE_DEV_SERVER_URL || (isDev ? 'http://localhost:5173' : null)

  console.log('VITE_DEV_SERVER_URL:', process.env.VITE_DEV_SERVER_URL)
  console.log('NODE_ENV:', process.env.NODE_ENV)

  if (devUrl) {
    mainWindow.loadURL(devUrl)
    if (isDev) {
      mainWindow.webContents.openDevTools({ mode: 'detach' })
    }
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  // 页面加载成功后兜底显示
  mainWindow.webContents.on('did-finish-load', () => {
    try {
      if (!mainWindow.isVisible()) {
        mainWindow.show()
      }
    } catch (e) {
      console.error('did-finish-load 显示窗口失败:', e)
    }
  })

  // 页面加载失败时自动重试一次（开发模式）
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error('页面加载失败:', { errorCode, errorDescription, validatedURL })
    if (devUrl) {
      setTimeout(() => {
        try {
          console.log('重试加载开发服务器:', devUrl)
          mainWindow.loadURL(devUrl)
        } catch (e) {
          console.error('重试加载失败:', e)
        }
      }, 500)
    }
  })

  // 超时兜底强制显示，避免 ready-to-show 未触发导致窗口不出现
  setTimeout(() => {
    try {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        console.warn('超时兜底：强制显示窗口')
        mainWindow.show()
      }
    } catch (e) {
      console.error('超时兜底显示失败:', e)
    }
  }, 3000)

  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' }
  })
}

// 在应用准备好时进行清理
app.whenReady().then(() => {
  // 清理旧的缓存
  try {
    const ses = require('electron').session;
    ses.defaultSession.clearCache()
      .then(() => {
        console.log('清除默认会话缓存成功');
      })
      .catch(err => {
        console.error('清除默认会话缓存失败:', err);
      });
  } catch (error) {
    console.error('清理缓存出错:', error);
  }

  // 创建系统托盘
  createTray();
  
  // 创建主窗口
  createWindow();
  
  // 启动时恢复规则：除「用户主动停止」以外的规则一律重新拉起
  // （包括上次运行中断线后残留的 error / stopped 状态）
  const forwardings = store.get('forwardings') || [];
  forwardings.forEach(rule => {
    if (rule.desired === 'stopped') {
      console.log(`跳过用户已停止的规则: ${rule.id}`);
      return;
    }
    const type = rule.type || 'forward'
    if (type === 'reverse-ssh') {
      startReverseSSH(reverseParamsFromRule(rule))
    } else {
      startForwarding({
        remoteHost: rule.remoteHost,
        remotePort: rule.remotePort,
        localPort: rule.localPort
      });
    }
  });

  // 启动重连调度（断线后的 1/5/10/30 分钟重试由它驱动，30 分钟后固定 30 分钟）
  startRetryTimer();

  // 启动健康监控（每 5 分钟检查一次，本轮新增异常合并成一封告警邮件）
  startHealthMonitor();
});

// 单实例逻辑已提前处理（见文件顶部）

app.on('window-all-closed', () => {
  // 在 Windows 和 Linux 下，当所有窗口关闭时不退出应用
  // 因为我们希望应用继续在托盘中运行
  if (process.platform === 'darwin') {
    // macOS 下的标准行为：关闭窗口但保持应用运行
    return
  }
  // Windows 和 Linux 下也不退出，让应用在托盘中继续运行
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

const safeReply = (event, channel, data) => {
  try {
    if (!event.sender.isDestroyed()) {
      event.reply(channel, data);
    }
  } catch (error) {
    console.error('回复消息失败:', error);
  }
};

// 统一推送：有发起方 event 时用 reply；没有发起方的场景（启动恢复、重连调度）广播给当前窗口
const pushToRenderer = (event, channel, payload) => {
  if (event) {
    safeReply(event, channel, payload);
    return;
  }
  try {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  } catch (error) {
    console.error('推送状态失败:', error);
  }
};

const getRule = (id) => (store.get('forwardings') || []).find(f => f.id === id);

const updateRule = (id, patch) => {
  const current = store.get('forwardings') || [];
  const updated = current.map(f => f.id === id ? { ...f, ...patch } : f);
  store.set('forwardings', updated);
  return updated;
};

const setRuleStatus = (id, status, error = null, event = null) => {
  const updated = updateRule(id, { status, error: error || null });
  pushToRenderer(event, 'forwarding-status', { id, status, error: error || null });
  pushToRenderer(event, 'forwarding-rules-updated', updated);
  return updated;
};

// 反向 SSH 规则 -> startReverseSSH 参数（启动恢复与重连复用同一份
// 映射，避免两处漏字段）
const reverseParamsFromRule = (rule) => ({
  sshHost: rule.sshHost,
  sshPort: rule.sshPort,
  sshUser: rule.sshUser,
  sshPassword: rule.sshPassword,
  authType: rule.authType,
  keyPath: rule.keyPath,
  remoteBindHost: rule.remoteBindHost,
  remotePort: rule.remotePort,
  localPort: rule.localPort,
  id: rule.id
});

// ---- 断线重连调度 ----

const retryDelayMs = (attempts) =>
  RETRY_LADDER_MINUTES[Math.min(attempts, RETRY_LADDER_MINUTES.length - 1)] * 60 * 1000;

const cancelRetry = (id, why) => {
  if (retryQueue.delete(id)) {
    console.log(`已取消重连计划: ${id}${why ? ` (${why})` : ''}`);
  }
};

const scheduleRetry = (id, reason) => {
  const rule = getRule(id);
  if (!rule) {
    cancelRetry(id);
    return false;
  }
  if (rule.desired === 'stopped') {
    cancelRetry(id, '用户已停止');
    return false;
  }

  const prev = retryQueue.get(id);
  const attempts = prev ? prev.attempts : 0;
  const delay = retryDelayMs(attempts);
  const nextAt = Date.now() + delay;
  const minutes = Math.round(delay / 60000);
  const when = new Date(nextAt).toLocaleString();

  retryQueue.set(id, { attempts: attempts + 1, nextAt });
  const message = `${reason || '连接已断开'}；${minutes} 分钟后（${when}）进行第 ${attempts + 1} 次重连`;
  console.log(`[重连] ${id} ${message}`);
  logger.lifecycle(`${id} 定于 ${when} 重连（第 ${attempts + 1} 次，间隔 ${minutes} 分钟）| ${reason || '连接已断开'}`);
  setRuleStatus(id, 'error', message);
  return true;
};

const fireRetry = (id) => {
  const entry = retryQueue.get(id);
  if (!entry) return;

  const rule = getRule(id);
  if (!rule || rule.desired === 'stopped') {
    cancelRetry(id, rule ? '用户已停止' : '规则已删除');
    return;
  }

  const type = rule.type || 'forward';
  // 已经有监听 / SSH 连接在，说明这个计划过期了（例如期间手动启动过）
  if (type === 'reverse-ssh' ? sshClients.has(id) : forwardingServers.has(id)) {
    cancelRetry(id, '连接已存在');
    return;
  }

  entry.nextAt = Infinity; // 占位防重复触发；本次失败会由 scheduleRetry 重新排期
  console.log(`[重连] ${id} 开始第 ${entry.attempts} 次重连`);
  logger.lifecycle(`${id} 开始第 ${entry.attempts} 次重连`);

  if (type === 'reverse-ssh') {
    startReverseSSH(reverseParamsFromRule(rule), null, true);
  } else {
    startForwarding({
      remoteHost: rule.remoteHost,
      remotePort: rule.remotePort,
      localPort: rule.localPort
    }, null, true);
  }
};

const startRetryTimer = () => {
  if (retryTimer) return;
  retryTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of [...retryQueue.entries()]) {
      if (entry.nextAt <= now) {
        try {
          fireRetry(id);
        } catch (error) {
          console.error('重连失败:', error);
        }
      }
    }
  }, RETRY_TICK_MS);
};

// ---- 服务健康监控：每 5 分钟扫一遍规则，本轮新增的异常合并成一封告警邮件 ----

const HEALTH_CHECK_MS = 5 * 60 * 1000
// id -> 本次异常是否已发过告警邮件；服务恢复正常后清除，下次异常才会再发
const alertNotified = new Map()
let healthTimer = null
// 防重入：上一轮还没发完（SMTP 慢）时，本轮直接跳过，避免重复发信
let healthChecking = false

const ruleTypeLabel = (rule) => (rule.type === 'reverse-ssh' ? '反向 SSH' : '正向转发')

// 把「本轮新增的异常」拼成一封邮件的标题与正文
// newly: 本轮需要告警的规则；abnormalTotal / ruleTotal: 用于说明当前整体情况
const buildAlertMail = (newly, abnormalTotal, ruleTotal) => {
  const count = newly.length
  const subject =
    count === 1
      ? `[TunnelProxy] 转发服务异常: ${newly[0].id}`
      : `[TunnelProxy] 转发服务异常告警（${count} 项）`

  const blocks = newly.map((rule, i) => {
    const head = count > 1 ? `${i + 1}. ` : ''
    return [
      `${head}规则: ${rule.id}`,
      `${count > 1 ? '   ' : ''}类型: ${ruleTypeLabel(rule)}`,
      `${count > 1 ? '   ' : ''}状态: ${rule.status}`,
      `${count > 1 ? '   ' : ''}错误: ${rule.error || '无'}`
    ].join('\n')
  })

  const lines = [
    count === 1
      ? 'TunnelProxy 检测到 1 项转发服务异常：'
      : `TunnelProxy 检测到 ${count} 项转发服务异常：`,
    '',
    blocks.join('\n\n'),
    '',
    `当前异常规则 ${abnormalTotal} 条，规则总数 ${ruleTotal} 条。`,
    `检测时间: ${new Date().toLocaleString()}`,
    `日志目录: ${logger.getDir() || '未启用'}`
  ]

  return { subject, text: lines.join('\n') }
}

const checkServiceHealth = async () => {
  if (healthChecking) return
  healthChecking = true
  try {
    const rules = store.get('forwardings') || []
    const abnormal = [] // 当前所有异常规则（含已告警过的）
    const pending = [] // 其中还没告警过的，本次要发的

    for (const rule of rules) {
      // 用户主动停止 / 运行中 = 正常：顺手清标记，下次异常才会重新发告警
      if (rule.desired !== 'running' || rule.status === 'running') {
        alertNotified.delete(rule.id)
        continue
      }
      // 剩下的是异常态（error 等，含断线排队等重连中）
      abnormal.push(rule)
      if (!alertNotified.has(rule.id)) pending.push(rule)
    }

    if (pending.length === 0) return

    // 多个异常同时出现只发一封邮件，内容逐条列出
    const { subject, text } = buildAlertMail(pending, abnormal.length, rules.length)
    // 只有发送成功才标记已发；失败则下个周期自动重试，避免邮件丢了就不再提醒
    const sent = await mailer.sendAlert({ subject, text })
    if (!sent) return

    pending.forEach((rule) => alertNotified.set(rule.id, true))
    logger.lifecycle(
      `已发送异常告警邮件（${pending.length} 项）: ${pending.map((r) => r.id).join(', ')}`
    )
  } finally {
    healthChecking = false
  }
}

const startHealthMonitor = () => {
  if (healthTimer) return
  healthTimer = setInterval(() => {
    checkServiceHealth().catch(err => console.error('健康检查失败:', err))
  }, HEALTH_CHECK_MS)
}

// 创建一个辅助函数来启动转发
const startForwarding = (params, event = null, isRetry = false) => {
  const { remoteHost, remotePort, localPort } = params;
  const id = `${remoteHost}:${remotePort}->${localPort}`;
  
  // 检查是否已经存在这个转发规则
  const forwardings = store.get('forwardings');
  const existingRule = forwardings.find(f => f.id === id);
  
  if (!existingRule) {
    const newForwarding = {
      id,
      remoteHost,
      remotePort,
      localPort,
      status: 'stopped',
      type: 'forward',
      desired: 'running',
      createdAt: new Date().toISOString()
    };
    store.set('forwardings', [...forwardings, newForwarding]);
  } else {
    updateRule(id, { desired: 'running' });
  }

  if (forwardingServers.has(id)) {
    console.log(`转发规则已经在运行: ${id}`);
    return;
  }

  // 只有用户手动启动才清掉重连计划；重连自身调用时不能清（否则阶梯永远停在第一档）
  if (!isRetry) {
    cancelRetry(id, '手动启动');
  }

  let listening = false; // 区分 listen 失败（可重试）与运行期错误

  const server = net.createServer((socket) => {
    if (!server.clients) {
      server.clients = new Set();
    }
    server.clients.add(socket);

    const startedAt = Date.now();
    // 对端地址要在 socket 销毁前取，destroy 之后 remoteAddress 会变 undefined
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    let endReason = 'closed';
    let logged = false;
    const logRequest = () => {
      if (logged) return;
      logged = true;
      logger.request({
        type: 'forward',
        id,
        peer,
        target: `${remoteHost}:${remotePort}`,
        ms: Date.now() - startedAt,
        up: socket.bytesRead,
        down: socket.bytesWritten,
        reason: endReason
      });
    };

    console.log(`新的连接请求: ${localPort} -> ${remoteHost}:${remotePort}`);
    
    const client = net.createConnection({
      host: remoteHost,
      port: parseInt(remotePort),
      timeout: 5000
    }, () => {
      console.log('成功连接到远程服务器');
      socket.pipe(client);
      client.pipe(socket);
    });

    const cleanup = () => {
      if (server.clients) {
        server.clients.delete(socket);
      }
      try {
        socket.destroy();
        client.destroy();
      } catch (err) {
        console.error('清理连接时出错:', err);
      }
      logRequest();
    };

    client.on('error', (err) => {
      console.error('远程连接错误:', err);
      endReason = `error:${err.code || err.message}`;
      cleanup();
      if (event) {
        safeReply(event, 'forwarding-status', {
          id: id,
          status: 'error',
          error: `连接错误: ${err.message} (${err.code})`
        });
      }
    });

    client.on('timeout', () => {
      console.error('连接超时');
      endReason = 'timeout';
      cleanup();
    });

    socket.on('error', (err) => {
      console.error('本地连接错误:', err);
      endReason = `local-error:${err.code || err.message}`;
      cleanup();
    });

    socket.on('end', () => {
      endReason = 'local-fin';
      cleanup();
    });
    client.on('end', () => {
      endReason = 'remote-fin';
      cleanup();
    });
    socket.on('close', cleanup);
    client.on('close', cleanup);
  });

  server.on('error', (err) => {
    console.error('服务器错误:', err);
    setRuleStatus(id, 'error', err.message, event);

    // 从未监听成功（典型 EADDRINUSE）才排重连；运行期错误不动重连计划
    if (!listening) {
      scheduleRetry(id, `启动失败: ${err.message}`);
    }
  });

  try {
    server.listen(parseInt(localPort), '0.0.0.0', () => {
      listening = true;
      console.log(`转发服务启动: ${localPort} -> ${remoteHost}:${remotePort}`);
      cancelRetry(id, '启动成功');
      setRuleStatus(id, 'running', null, event);
    });

    forwardingServers.set(id, server);
  } catch (err) {
    console.error('启动服务器失败:', err);
    setRuleStatus(id, 'error', err.message, event);
    scheduleRetry(id, `启动失败: ${err.message}`);
  }
};

// 基于 ssh2 库的反向端口转发，支持密码认证
const startReverseSSH = (params, event = null, isRetry = false) => {
  const {
    sshHost,
    sshPort = 22,
    sshUser,
    sshPassword,
    authType = 'password',
    keyPath,
    remoteBindHost = '0.0.0.0',
    remotePort,
    localPort,
    id: customId
  } = params

  const id = customId || `${sshHost}:${remotePort}<-${localPort}`

  // 持久化规则
  const forwardings = store.get('forwardings');
  const existingRule = forwardings.find(f => f.id === id);
  if (!existingRule) {
    const newRule = {
      id,
      type: 'reverse-ssh',
      sshHost,
      sshPort,
      sshUser,
      sshPassword,
      authType,
      keyPath: keyPath || null,
      remoteBindHost,
      remotePort,
      localPort,
      status: 'stopped',
      desired: 'running',
      createdAt: new Date().toISOString()
    }
    store.set('forwardings', [...forwardings, newRule])
  } else {
    updateRule(id, { desired: 'running' })
  }

  // 只有用户手动启动才清掉重连计划；重连自身调用时不能清（否则阶梯永远停在第一档）
  if (!isRetry) {
    cancelRetry(id, '手动启动')
  }

  if (sshClients.has(id)) {
    console.log(`反向 SSH 已在运行: ${id}`)
    return
  }

  // event 可能为 null（启动恢复 / 重连调度），仍然要能推到界面
  const updateStatus = (status, error) => setRuleStatus(id, status, error, event)

  const conn = new Client()
  sshClients.set(id, conn)

  // 一次连接生命周期内只结算一次：error / end / close 谁先到算谁
  let finished = false
  let failReason = null

  const settle = (reason) => {
    if (finished) return
    finished = true
    sshClients.delete(id)
    console.log(`反向 SSH 已终止: ${id} (${reason})`)

    const rule = getRule(id)
    if (!rule || rule.desired === 'stopped') {
      // 用户主动停止或规则已删除：只落状态，不排重连
      setRuleStatus(id, 'stopped', null, event)
      return
    }
    if (!scheduleRetry(id, reason)) {
      setRuleStatus(id, 'error', reason, event)
    }
  }

  console.log(`启动反向 SSH: ${sshUser}@${sshHost}:${sshPort} -> ${remoteBindHost}:${remotePort}<-127.0.0.1:${localPort}`)

  conn.on('ready', () => {
    console.log(`SSH 连接已建立: ${id}`)
    
    // 建立反向端口转发
    conn.forwardIn(remoteBindHost, remotePort, (err) => {
      if (err) {
        console.error(`反向转发失败: ${err.message}`)
        failReason = `端口转发失败: ${err.message}`
        conn.end()
        return
      }
      
      console.log(`反向转发已建立: ${remoteBindHost}:${remotePort} -> 127.0.0.1:${localPort}`)
      cancelRetry(id, '连接成功')
      updateStatus('running')
    })
  })

  conn.on('tcp connection', (info, accept, reject) => {
    console.log(`收到反向连接请求: ${info.srcIP}:${info.srcPort}`)

    const startedAt = Date.now()
    let endReason = 'closed'
    let logged = false
    const stream = accept()
    const localConn = net.createConnection({
      host: '127.0.0.1',
      port: localPort
    })

    const logRequest = () => {
      if (logged) return
      logged = true
      logger.request({
        type: 'reverse-ssh',
        id,
        peer: `${info.srcIP}:${info.srcPort}`,
        target: `127.0.0.1:${localPort}`,
        ms: Date.now() - startedAt,
        up: localConn.bytesWritten,
        down: localConn.bytesRead,
        reason: endReason
      })
    }

    stream.on('close', () => {
      if (endReason === 'closed') endReason = 'remote-close'
      localConn.end()
    })

    localConn.on('close', () => {
      if (endReason === 'closed') endReason = 'local-close'
      stream.end()
      logRequest()
    })

    stream.on('error', (err) => {
      console.error(`反向流错误: ${err.message}`)
      endReason = `remote-error:${err.code || err.message}`
      localConn.end()
    })

    localConn.on('error', (err) => {
      console.error(`本地连接错误: ${err.message}`)
      endReason = `local-error:${err.code || err.message}`
      stream.end()
    })

    // 双向数据转发
    stream.pipe(localConn)
    localConn.pipe(stream)
  })

  conn.on('error', (err) => {
    console.error(`SSH 连接错误: ${err.message}`)
    failReason = failReason || `连接失败: ${err.message}`
    settle(failReason)
  })

  conn.on('end', () => {
    console.log(`SSH 连接已断开: ${id}`)
    settle(failReason || '连接已断开')
  })

  conn.on('close', () => {
    settle(failReason || '连接已关闭')
  })

  // 连接配置
  const connConfig = {
    host: sshHost,
    port: sshPort,
    username: sshUser,
    keepaliveInterval: 60000,
    keepaliveCountMax: 3,
  }

  if (authType === 'password' && sshPassword) {
    connConfig.password = sshPassword
  } else if (authType === 'key' && keyPath && fs.existsSync(keyPath)) {
    connConfig.privateKey = fs.readFileSync(keyPath)
  } else {
    // 认证信息缺失：连接对象不能留在 Map 里，否则后续启动/重连都会被 has(id) 挡掉
    sshClients.delete(id)
    finished = true
    updateStatus('error', '缺少认证信息：请提供密码或密钥文件')
    scheduleRetry(id, '缺少认证信息：请提供密码或密钥文件')
    return
  }

  // 建立连接
  conn.connect(connConfig)
}

// 修改 start-forwarding 事件处理
ipcMain.on('start-forwarding', (event, params) => {
  try {
    startForwarding(params, event);
  } catch (error) {
    console.error('启动转发失败:', error);
    event.reply('forwarding-status', {
      id: `${params.remoteHost}:${params.remotePort}->${params.localPort}`,
      status: 'error',
      error: error.message
    });
  }
});

// 启动反向 SSH
ipcMain.on('start-reverse-ssh', (event, params) => {
  try {
    startReverseSSH(params, event)
  } catch (error) {
    console.error('启动反向 SSH 失败:', error)
    event.reply('forwarding-status', {
      id: params.id || `${params.sshHost}:${params.remotePort}<-${params.localPort}`,
      status: 'error',
      error: error.message
    })
  }
})

// 停止转发
ipcMain.on('stop-forwarding', (event, id) => {
  cancelRetry(id, '用户停止');
  updateRule(id, { desired: 'stopped' });
  try {
    const server = forwardingServers.get(id);
    if (server) {
      try {
        // 关闭所有现有连接
        server.clients?.forEach(client => {
          try {
            client.destroy();
          } catch (err) {
            console.error('关闭客户端连接失败:', err);
          }
        });

        // 强制关闭服务器
        server.close();
        server.unref();

        const forwardings = store.get('forwardings');
        const updatedForwardings = forwardings.map(f => 
          f.id === id ? { ...f, status: 'stopped', error: null } : f
        );
        store.set('forwardings', updatedForwardings);

        console.log(`停止转发: ${id}`);
        event.reply('forwarding-status', {
          id: id,
          status: 'stopped'
        });
        event.reply('forwarding-rules-updated', updatedForwardings);

        // 从 Map 中移除服务器引用
        forwardingServers.delete(id);
      } catch (err) {
        console.error('停止服务器时出错:', err);
        event.reply('forwarding-status', {
          id: id,
          status: 'error',
          error: `停止失败: ${err.message}`
        });
      }
    }
  } catch (error) {
    console.error('停止转发失败:', error);
    event.reply('forwarding-status', {
      id,
      status: 'error',
      error: error.message
    });
  }
});

// 停止反向 SSH
ipcMain.on('stop-reverse-ssh', (event, id) => {
  cancelRetry(id, '用户停止')
  updateRule(id, { desired: 'stopped' })
  try {
    const client = sshClients.get(id)
    if (client) {
      try {
        client.end()
      } catch (e) {
        console.error('关闭 SSH 连接失败:', e)
      }
      sshClients.delete(id)
    }
    // 无论有没有活动连接都要落状态：否则「等待重连」的规则点了停止会一直停在错误态
    setRuleStatus(id, 'stopped', null, event)
  } catch (error) {
    console.error('停止反向 SSH 失败:', error)
    event.reply('forwarding-status', { id, status: 'error', error: error.message })
  }
})

// 获取所有规则
ipcMain.handle('get-forwarding-rules', () => {
  try {
    return store.get('forwardings') || [];
  } catch (error) {
    console.error('获取规则失败:', error);
    return [];
  }
});

// 删除规则
ipcMain.on('delete-forwarding', (event, id) => {
  cancelRetry(id, '规则已删除');
  const forwardings = store.get('forwardings');
  const updatedForwardings = forwardings.filter(f => f.id !== id);
  store.set('forwardings', updatedForwardings);
  
  const server = forwardingServers.get(id);
  if (server) {
    server.close();
    forwardingServers.delete(id);
  }
  const client = sshClients.get(id)
  if (client) {
    try { client.end() } catch (e) {}
    sshClients.delete(id)
  }
  
  event.reply('forwarding-rules-updated', updatedForwardings);
});

// 编辑规则
ipcMain.on('edit-forwarding', (event, { oldId, newRule }) => {
  cancelRetry(oldId, '规则已编辑');
  const forwardings = store.get('forwardings');
  const updatedForwardings = forwardings.map(f => 
    f.id === oldId ? { ...newRule, desired: 'stopped' } : f
  );
  
  store.set('forwardings', updatedForwardings);
  
  const server = forwardingServers.get(oldId);
  if (server) {
    server.close();
    forwardingServers.delete(oldId);
  }
  const client = sshClients.get(oldId)
  if (client) {
    try { client.end() } catch (e) {}
    sshClients.delete(oldId)
  }
  
  event.reply('forwarding-rules-updated', updatedForwardings);
});

// 添加错误处理
app.on('render-process-gone', (event, webContents, details) => {
  console.error('渲染进程崩溃:', details);
});

app.on('child-process-gone', (event, details) => {
  console.error('子进程崩溃:', details);
});

// 在退出时进行清理
app.on('before-quit', (event) => {
  app.isQuiting = true
  
  try {
    // 停止重连调度，避免退出过程中又拉起连接
    if (retryTimer) {
      clearInterval(retryTimer)
      retryTimer = null
    }
    retryQueue.clear()

    // 停止健康监控，避免退出过程中还尝试发邮件
    if (healthTimer) {
      clearInterval(healthTimer)
      healthTimer = null
    }

    // 销毁托盘图标
    if (tray) {
      tray.destroy()
      tray = null
    }
    
    // 关闭所有转发服务
    for (const [id, server] of forwardingServers.entries()) {
      try {
        server.close();
        forwardingServers.delete(id);
      } catch (error) {
        console.error(`关闭服务器失败 ${id}:`, error);
      }
    }
    for (const [id, client] of sshClients.entries()) {
      try {
        client.end()
        sshClients.delete(id)
      } catch (error) {
        console.error(`关闭 SSH 连接失败 ${id}:`, error)
      }
    }
  } catch (error) {
    console.error('退出清理失败:', error);
  }
});