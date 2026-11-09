// 检查新版 main 进程各模块能否正常加载
const { app } = require('electron');

app.setPath('userData', 'C:/Users/PC/AppData/Roaming/JobMatch Agent');

app.whenReady().then(() => {
  const targets = [
    '../build/dist-new2/win-unpacked/resources/app.asar/src/browser-agent.js',
    '../build/dist-new2/win-unpacked/resources/app.asar/src/backend.js',
  ];
  // asar 内的文件可以直接 require
  const asar = 'C:/Users/PC/Documents/deepseek-harness/default-workspace/job-agent/build/dist-new2/win-unpacked/resources/app.asar';
  const list = [
    asar + '/src/browser-agent.js',
    asar + '/src/backend.js',
    asar + '/src/preload.js',
  ];
  for (const p of list) {
    try {
      const m = require(p);
      console.log('OK  ', p.split('app.asar')[1], '→', Object.keys(m).join(','));
    } catch (e) {
      console.log('FAIL', p.split('app.asar')[1], '→', e.message);
      console.log((e.stack || '').split('\n').slice(0, 4).join('\n'));
    }
  }
  app.exit(0);
});
