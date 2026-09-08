# Screen Room

随机房间号的浏览器实时房间。用户可设置昵称、发送聊天消息、查看成员列表，并独立共享或关闭自己的屏幕；每个屏幕卡片都可全屏。媒体流通过 WebRTC 点对点传输。

## 本地运行

```bash
npm install
npm run dev
```

## 部署到 Vercel

将仓库导入 Vercel，Framework Preset 选择 **Vite**，构建命令为 `npm run build`，输出目录为 `dist`。`vercel.json` 已配置单页路由，无需额外改动。

## 自定义 STUN / TURN

编辑 `src/config/webrtc.ts` 中的 `webRTCConfig.iceServers`：

```ts
iceServers: [
  { urls: 'stun:stun.example.com:3478' },
  { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'password' },
]
```

浏览器前端的 TURN 密钥会被用户看到。生产环境应使用短期凭证，或从受保护的后端接口获取配置。

## 信令

默认使用 PeerJS Cloud 来协商 WebRTC 连接，因此 Vercel 仅部署前端也能运行。若部署自己的 PeerServer，请在同一文件中修改 `peerServerConfig`；它只处理信令，不转发屏幕画面。
