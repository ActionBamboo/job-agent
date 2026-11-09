// 为已安装的 JobMatch Agent 创建桌面与开始菜单快捷方式。
// 用法（在 desktop 目录下）：
//   ./node_modules/electron/dist/electron.exe ../scripts/make_shortcut.js --no-sandbox
const { app, shell } = require('electron')
const path = require('path')
const fs = require('fs')

app.whenReady().then(() => {
  const exe = path.join(process.env.LOCALAPPDATA, 'Programs', 'JobMatch Agent', 'JobMatch Agent.exe')
  if (!fs.existsSync(exe)) {
    console.error('找不到已安装的主程序：' + exe)
    app.exit(1)
    return
  }
  const opts = {
    target: exe,
    cwd: path.dirname(exe),
    icon: exe,
    iconIndex: 0,
    description: 'JobMatch Agent - AI 岗位匹配助手',
  }
  const targets = [
    path.join(app.getPath('desktop'), 'JobMatch Agent.lnk'),
    path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'JobMatch Agent.lnk'),
  ]
  for (const p of targets) {
    const ok = shell.writeShortcutLink(p, 'create', opts)
    console.log((ok ? 'OK   ' : 'FAIL ') + p)
  }
  app.exit(0)
})
