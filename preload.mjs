// preload.mjs — PPT Service 桌面应用预加载脚本
// 通过 contextBridge 安全暴露 API 给渲染进程

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('pptService', {
  // 设置
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),

  // 服务器控制
  startServer: (port) => ipcRenderer.invoke('start-server', port),
  stopServer: () => ipcRenderer.invoke('stop-server'),
  restartServer: () => ipcRenderer.invoke('restart-server'),
  getStatus: () => ipcRenderer.invoke('get-status'),

  // CDP
  checkCdp: () => ipcRenderer.invoke('check-cdp'),
  runCdp: (opts) => ipcRenderer.invoke('run-cdp', opts),

  // Edge
  checkEdge: () => ipcRenderer.invoke('check-edge'),
  launchEdge: () => ipcRenderer.invoke('launch-edge'),

  // 文件/目录
  openFolder: (p) => ipcRenderer.invoke('open-folder', p),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),

  // 监听来自主进程的事件
  onLog: (cb) => {
    const handler = (e, data) => cb(data);
    ipcRenderer.on('log', handler);
    return () => ipcRenderer.removeListener('log', handler);
  },
  onServerStatus: (cb) => {
    const handler = (e, data) => cb(data);
    ipcRenderer.on('server-status', handler);
    return () => ipcRenderer.removeListener('server-status', handler);
  },
  onCdpStatus: (cb) => {
    const handler = (e, data) => cb(data);
    ipcRenderer.on('cdp-status', handler);
    return () => ipcRenderer.removeListener('cdp-status', handler);
  },
});
