/**
 * WebRTC / PeerJS 配置。
 * 修改 iceServers 即可换成自己的 STUN、TURN 服务；TURN 账号密码建议只用于
 * 内部部署或由后端短时签发，避免把长期密钥暴露在浏览器构建产物中。
 */
export const webRTCConfig: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    // { urls: 'turn:turn.example.com:3478', username: 'your-user', credential: 'your-password' },
    // { urls: 'turns:turn.example.com:5349', username: 'your-user', credential: 'your-password' },
  ],
}

/** PeerJS 信令服务。默认是 PeerJS Cloud；可替换为自行部署的 PeerServer。 */
export const peerServerConfig = {
  host: '0.peerjs.com',
  port: 443,
  path: '/',
  secure: true,
}
