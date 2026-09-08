import { FormEvent, useEffect, useRef, useState } from 'react'
import Peer, { DataConnection, MediaConnection } from 'peerjs'
import { peerServerConfig, webRTCConfig } from './config/webrtc'

type Mode = 'idle' | 'host' | 'guest'
type Status = '准备就绪' | '正在连接…' | '等待观看者加入' | '已连接' | '连接失败'

const makeRoomId = () => crypto.getRandomValues(new Uint32Array(1))[0].toString(36).toUpperCase().padStart(6, '0').slice(-6)
const hostPeerId = (roomId: string) => `screen-room-${roomId.toLowerCase()}`
const cleanRoomId = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12)

function App() {
  const [roomId, setRoomId] = useState('')
  const [mode, setMode] = useState<Mode>('idle')
  const [status, setStatus] = useState<Status>('准备就绪')
  const [message, setMessage] = useState('创建房间后选择要共享的屏幕或窗口。')
  const [viewerCount, setViewerCount] = useState(0)
  const localVideo = useRef<HTMLVideoElement>(null)
  const remoteVideo = useRef<HTMLVideoElement>(null)
  const peerRef = useRef<Peer | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const callsRef = useRef<Map<string, MediaConnection>>(new Map())

  useEffect(() => () => stopSession(), [])

  function stopSession() {
    callsRef.current.forEach(call => call.close())
    callsRef.current.clear()
    peerRef.current?.destroy()
    peerRef.current = null
    streamRef.current?.getTracks().forEach(track => track.stop())
    streamRef.current = null
    if (localVideo.current) localVideo.current.srcObject = null
    if (remoteVideo.current) remoteVideo.current.srcObject = null
  }

  function reset() {
    stopSession()
    setMode('idle'); setStatus('准备就绪'); setViewerCount(0)
    setMessage('会话已结束。')
  }

  function buildPeer(id?: string) {
    const options = { ...peerServerConfig, config: webRTCConfig, debug: 1 }
    return id ? new Peer(id, options) : new Peer(options)
  }

  async function createRoom() {
    reset()
    const newRoom = makeRoomId()
    setRoomId(newRoom); setMode('host'); setStatus('正在连接…')
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      streamRef.current = stream
      if (localVideo.current) localVideo.current.srcObject = stream
      stream.getVideoTracks()[0]?.addEventListener('ended', reset)
      const peer = buildPeer(hostPeerId(newRoom))
      peerRef.current = peer
      peer.on('open', () => { setStatus('等待观看者加入'); setMessage(`房间 ${newRoom} 已创建，把房间号发给观看者即可。`) })
      peer.on('error', error => {
        setStatus('连接失败')
        setMessage(error.type === 'unavailable-id' ? '该房间号暂时被占用，请重新创建。' : `信令连接出错：${error.type}`)
      })
      peer.on('connection', connection => handleViewerRequest(connection, stream))
    } catch (error) {
      reset()
      setMessage(error instanceof DOMException && error.name === 'NotAllowedError' ? '未获得屏幕共享权限。' : '无法开始屏幕共享。')
    }
  }

  function handleViewerRequest(connection: DataConnection, stream: MediaStream) {
    connection.on('open', () => {
      const call = peerRef.current?.call(connection.peer, stream)
      if (!call) return
      callsRef.current.set(connection.peer, call)
      setViewerCount(callsRef.current.size); setStatus('已连接')
      call.on('close', () => { callsRef.current.delete(connection.peer); setViewerCount(callsRef.current.size) })
      call.on('error', () => { callsRef.current.delete(connection.peer); setViewerCount(callsRef.current.size) })
    })
  }

  function joinRoom(event: FormEvent) {
    event.preventDefault()
    const safeId = cleanRoomId(roomId)
    if (!safeId) { setMessage('请输入有效房间号。'); return }
    reset(); setRoomId(safeId); setMode('guest'); setStatus('正在连接…'); setMessage('正在请求共享画面…')
    const peer = buildPeer()
    peerRef.current = peer
    peer.on('open', () => {
      const connection = peer.connect(hostPeerId(safeId), { reliable: true })
      connection.on('error', () => failedJoin())
      peer.on('call', call => answerCall(call))
    })
    peer.on('error', failedJoin)
  }

  function answerCall(call: MediaConnection) {
    call.answer()
    call.on('stream', stream => {
      if (remoteVideo.current) remoteVideo.current.srcObject = stream
      setStatus('已连接'); setMessage('正在观看共享屏幕。')
    })
    call.on('close', () => { setStatus('连接失败'); setMessage('共享者已结束会话。') })
    call.on('error', failedJoin)
  }

  function failedJoin() {
    setStatus('连接失败'); setMessage('无法加入该房间。请确认房间号正确，且共享者仍在线。')
  }

  async function copyRoom() {
    await navigator.clipboard.writeText(roomId)
    setMessage('房间号已复制。')
  }

  const isHost = mode === 'host'
  const isInSession = mode !== 'idle'
  return <main className="app-shell">
    <section className="card">
      <div className="brand"><span className="brand-mark">↗</span><div><h1>Screen Room</h1><p>输入房间号，即刻共享屏幕</p></div></div>
      {!isInSession && <>
        <button className="primary" onClick={createRoom}>创建随机房间并共享</button>
        <div className="divider"><span>或</span></div>
        <form onSubmit={joinRoom} className="join-form">
          <label htmlFor="room">加入已有房间</label>
          <div className="input-row"><input id="room" value={roomId} onChange={e => setRoomId(cleanRoomId(e.target.value))} placeholder="例如 A9K2MZ" autoComplete="off" /><button>加入</button></div>
        </form>
      </>}
      {isInSession && <>
        <div className="room-panel"><span>房间号</span><strong>{roomId}</strong>{isHost && <button className="copy" onClick={copyRoom}>复制</button>}</div>
        <div className="status"><i className={status === '已连接' || status === '等待观看者加入' ? 'live' : ''} />{status}{isHost && <em>{viewerCount} 位观看者</em>}</div>
        <video ref={isHost ? localVideo : remoteVideo} autoPlay playsInline muted={isHost} className="screen" />
        <button className="end" onClick={reset}>结束会话</button>
      </>}
      <p className="message">{message}</p>
    </section>
    <p className="footnote">画面通过端到端 WebRTC 传输；PeerJS 只用于建立连接。</p>
  </main>
}

export default App
