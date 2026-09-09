import { FormEvent, useEffect, useRef, useState } from 'react'
import Peer, { DataConnection, MediaConnection } from 'peerjs'
import { peerServerConfig, webRTCConfig } from './config/webrtc'

type Mode = 'idle' | 'host' | 'guest'
type Status = '准备就绪' | '正在连接…' | '已连接' | '连接失败'
type RoomUser = { id: string; name: string; sharing: boolean }
type ChatItem = { id: string; name: string; text: string; mine: boolean }
type Packet =
  | { type: 'join'; name: string }
  | { type: 'chat'; id: string; name: string; text: string }
  | { type: 'roster'; users: RoomUser[] }
  | { type: 'sharing'; userId: string; sharing: boolean }
  | { type: 'heartbeat' }

const makeRoomId = () => crypto.getRandomValues(new Uint32Array(1))[0].toString(36).toUpperCase().padStart(6, '0').slice(-6)
const hostPeerId = (roomId: string) => `screen-room-${roomId.toLowerCase()}`
const cleanRoomId = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12)
const makeName = () => `访客${Math.floor(100 + Math.random() * 900)}`
const roomIdFromPath = () => cleanRoomId(window.location.pathname.split('/').filter(Boolean)[0] || '')

function App() {
  const [roomId, setRoomId] = useState(roomIdFromPath)
  const [nickname, setNickname] = useState(makeName)
  const [mode, setMode] = useState<Mode>('idle')
  const [status, setStatus] = useState<Status>('准备就绪')
  const [message, setMessage] = useState('创建房间，或输入房间号加入。')
  const [users, setUsers] = useState<RoomUser[]>([])
  const [chat, setChat] = useState<ChatItem[]>([])
  const [draft, setDraft] = useState('')
  const [sharing, setSharing] = useState(false)
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map())
  const localVideo = useRef<HTMLVideoElement>(null)
  const peerRef = useRef<Peer | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const connectionsRef = useRef<Map<string, DataConnection>>(new Map())
  const hostConnectionRef = useRef<DataConnection | null>(null)
  const usersRef = useRef<Map<string, RoomUser>>(new Map())
  const incomingCallsRef = useRef<Map<string, MediaConnection>>(new Map())
  const lastSeenRef = useRef<Map<string, number>>(new Map())
  const presenceTimerRef = useRef<number | null>(null)
  const nicknameRef = useRef(nickname)
  const myIdRef = useRef('')

  useEffect(() => { nicknameRef.current = nickname }, [nickname])
  useEffect(() => () => stopSession(), [])

  function stopSession() {
    incomingCallsRef.current.forEach(call => call.close())
    incomingCallsRef.current.clear()
    connectionsRef.current.forEach(connection => connection.close())
    connectionsRef.current.clear(); hostConnectionRef.current?.close(); hostConnectionRef.current = null
    peerRef.current?.destroy(); peerRef.current = null
    if (presenceTimerRef.current) window.clearInterval(presenceTimerRef.current)
    presenceTimerRef.current = null
    streamRef.current?.getTracks().forEach(track => track.stop()); streamRef.current = null
    if (localVideo.current) localVideo.current.srcObject = null
    usersRef.current.clear(); lastSeenRef.current.clear(); myIdRef.current = ''
  }

  function reset() {
    stopSession(); setMode('idle'); setStatus('准备就绪'); setUsers([]); setChat([]); setSharing(false); setRemoteStreams(new Map())
    window.history.replaceState({}, '', '/')
    setMessage('会话已结束。')
  }

  function buildPeer(id?: string) {
    const options = { ...peerServerConfig, config: webRTCConfig, debug: 1 }
    return id ? new Peer(id, options) : new Peer(options)
  }
  function roster() { return [...usersRef.current.values()] }
  function safeSend(connection: DataConnection | null | undefined, packet: Packet) {
    if (!connection?.open) return false
    try { connection.send(packet); return true } catch { return false }
  }
  function broadcast(packet: Packet) { connectionsRef.current.forEach(connection => safeSend(connection, packet)) }
  function sendToHost(packet: Packet) {
    if (!safeSend(hostConnectionRef.current, packet)) {
      setMessage('与房主的连接尚未准备好，请稍后再试。')
      return false
    }
    return true
  }
  function publishRoster() {
    const packet: Packet = { type: 'roster', users: roster() }
    packet.users.filter(user => !user.sharing && user.id !== myIdRef.current).forEach(user => removeRemoteStream(user.id))
    broadcast(packet); setUsers(packet.users)
  }
  function setLocalUser(id: string, sharingNow = false) { usersRef.current.set(id, { id, name: nicknameRef.current.trim() || makeName(), sharing: sharingNow }) }

  function removeRemoteStream(peerId: string) {
    incomingCallsRef.current.delete(peerId)
    setRemoteStreams(previous => { const next = new Map(previous); next.delete(peerId); return next })
  }
  function configurePeer(peer: Peer) {
    peer.on('call', call => {
      const stream = streamRef.current
      if (stream) call.answer(stream); else call.answer()
      call.on('stream', received => { setRemoteStreams(previous => new Map(previous).set(call.peer, received)); incomingCallsRef.current.set(call.peer, call) })
      call.on('close', () => removeRemoteStream(call.peer)); call.on('error', () => removeRemoteStream(call.peer))
    })
    peer.on('error', error => { setStatus('连接失败'); setMessage(error.type === 'unavailable-id' ? '该房间号暂时被占用，请重新创建。' : `连接出错：${error.type}`) })
  }

  function handleHostConnection(connection: DataConnection) {
    connectionsRef.current.set(connection.peer, connection)
    connection.on('data', data => handleHostPacket(connection.peer, data as Packet))
    connection.on('close', () => removeMember(connection.peer))
    connection.on('error', () => connection.close())
  }
  function handleHostPacket(peerId: string, packet: Packet) {
    lastSeenRef.current.set(peerId, Date.now())
    if (packet.type === 'join') {
      usersRef.current.set(peerId, { id: peerId, name: packet.name.slice(0, 24) || '匿名用户', sharing: false })
      publishRoster()
      // 已在共享的房主主动将现有流推送给刚加入的成员。
      if (streamRef.current) peerRef.current?.call(peerId, streamRef.current)
      return
    }
    if (packet.type === 'chat') { broadcast(packet); addChat({ ...packet, mine: false }); return }
    if (packet.type === 'heartbeat') return
    if (packet.type === 'sharing') {
      const user = usersRef.current.get(peerId)
      if (user) { user.sharing = packet.sharing; usersRef.current.set(peerId, user); publishRoster() }
    }
  }
  function removeMember(peerId: string) {
    const wasMember = usersRef.current.delete(peerId)
    lastSeenRef.current.delete(peerId); connectionsRef.current.delete(peerId); removeRemoteStream(peerId)
    if (wasMember) publishRoster()
  }
  function startHostPresenceSweep() {
    presenceTimerRef.current = window.setInterval(() => {
      const deadline = Date.now() - 25000
      lastSeenRef.current.forEach((seenAt, peerId) => {
        if (seenAt < deadline) { connectionsRef.current.get(peerId)?.close(); removeMember(peerId) }
      })
    }, 5000)
  }
  function startGuestHeartbeat() {
    presenceTimerRef.current = window.setInterval(() => safeSend(hostConnectionRef.current, { type: 'heartbeat' }), 8000)
  }
  function handleGuestPacket(packet: Packet) {
    if (packet.type === 'roster') {
      const previousUsers = usersRef.current
      usersRef.current = new Map(packet.users.map(user => [user.id, user])); setUsers(packet.users)
      packet.users.filter(user => !user.sharing && user.id !== myIdRef.current).forEach(user => removeRemoteStream(user.id))
      // 已在共享的普通成员也主动向新加入者推送流，避免后来者反向拉流失败。
      if (streamRef.current) {
        packet.users.filter(user => user.id !== myIdRef.current && !previousUsers.has(user.id))
          .forEach(user => peerRef.current?.call(user.id, streamRef.current!))
      }
    }
    if (packet.type === 'chat') addChat({ ...packet, mine: packet.id === myIdRef.current })
  }
  function addChat(item: ChatItem) { setChat(previous => [...previous, item]) }
  function createRoom() {
    reset(); const newRoom = makeRoomId(); const name = nickname.trim() || makeName()
    setNickname(name); nicknameRef.current = name; setRoomId(newRoom); window.history.replaceState({}, '', `/${newRoom}`); setMode('host'); setStatus('正在连接…')
    const peer = buildPeer(hostPeerId(newRoom)); peerRef.current = peer; configurePeer(peer)
    peer.on('open', id => { myIdRef.current = id; setLocalUser(id); publishRoster(); startHostPresenceSweep(); setStatus('已连接'); setMessage(`房间 ${newRoom} 已创建。分享房间号，让朋友加入。`) })
    peer.on('connection', handleHostConnection)
  }
  function joinRoom(event: FormEvent) {
    event.preventDefault(); const safeId = cleanRoomId(roomId); const name = nickname.trim() || makeName()
    if (!safeId) { setMessage('请输入有效房间号。'); return }
    reset(); setNickname(name); nicknameRef.current = name; setRoomId(safeId); window.history.replaceState({}, '', `/${safeId}`); setMode('guest'); setStatus('正在连接…'); setMessage('正在加入房间…')
    const peer = buildPeer(); peerRef.current = peer; configurePeer(peer)
    peer.on('open', id => {
      myIdRef.current = id; setLocalUser(id); const connection = peer.connect(hostPeerId(safeId), { reliable: true }); hostConnectionRef.current = connection
      connection.on('open', () => { safeSend(connection, { type: 'join', name } satisfies Packet); startGuestHeartbeat(); setStatus('已连接'); setMessage('已加入房间。') })
      connection.on('data', data => handleGuestPacket(data as Packet))
      connection.on('close', () => { if (presenceTimerRef.current) window.clearInterval(presenceTimerRef.current); presenceTimerRef.current = null; setStatus('连接失败'); setMessage('房主已结束房间或网络已断开。') })
      connection.on('error', () => { if (presenceTimerRef.current) window.clearInterval(presenceTimerRef.current); presenceTimerRef.current = null; setStatus('连接失败'); setMessage('无法加入该房间，请检查房间号。') })
    })
  }

  async function toggleShare() {
    if (sharing) { endShare(); return }
    if (status !== '已连接' || !myIdRef.current) { setMessage('正在连接房间，请连接成功后再共享。'); return }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      streamRef.current = stream; setSharing(true); if (localVideo.current) localVideo.current.srcObject = stream
      stream.getVideoTracks()[0]?.addEventListener('ended', endShare)
      const myId = myIdRef.current; const local = usersRef.current.get(myId)
      if (local) { local.sharing = true; usersRef.current.set(myId, local) }
      if (mode === 'host') publishRoster(); else sendToHost({ type: 'sharing', userId: myId, sharing: true })
      roster().filter(user => user.id !== myId).forEach(user => peerRef.current?.call(user.id, stream))
    } catch { setMessage('未获得屏幕共享权限。') }
  }
  function endShare() {
    streamRef.current?.getTracks().forEach(track => track.stop()); streamRef.current = null; setSharing(false); if (localVideo.current) localVideo.current.srcObject = null
    const myId = myIdRef.current; const local = usersRef.current.get(myId)
    if (local) { local.sharing = false; usersRef.current.set(myId, local) }
    if (mode === 'host') publishRoster(); else sendToHost({ type: 'sharing', userId: myId, sharing: false })
  }
  function sendChat(event: FormEvent) {
    event.preventDefault(); const text = draft.trim(); if (!text || !myIdRef.current) return
    if (status !== '已连接') { setMessage('正在连接房间，请稍后发送消息。'); return }
    const packet: Packet = { type: 'chat', id: myIdRef.current, name: nicknameRef.current, text: text.slice(0, 500) }
    if (mode === 'host') { broadcast(packet); addChat({ ...packet, mine: true }) } else sendToHost(packet)
    setDraft('')
  }
  async function copyRoom() { await navigator.clipboard.writeText(`${window.location.origin}/${roomId}`); setMessage('房间链接已复制。') }
  function fullscreen(video: HTMLVideoElement | null) { video?.requestFullscreen?.() }
  const isInSession = mode !== 'idle'
  const videoCards = [...remoteStreams.entries()].map(([id, stream]) => ({ id, stream, mine: false }))
  if (sharing && streamRef.current) videoCards.unshift({ id: myIdRef.current, stream: streamRef.current, mine: true })

  return <main className="app-shell"><section className={`card ${isInSession ? 'room-card' : ''}`}>
    <div className="brand"><span className="brand-mark">↗</span><div><h1>Screen Room</h1><p>一个房间，一起聊天和共享屏幕</p></div></div>
    {!isInSession && <><label htmlFor="nickname">你的昵称</label><input id="nickname" className="full-input" value={nickname} maxLength={24} onChange={e => setNickname(e.target.value)} placeholder="输入昵称" /><button className="primary" onClick={createRoom}>创建随机房间</button><div className="divider"><span>或</span></div><form onSubmit={joinRoom} className="join-form"><label htmlFor="room">加入已有房间</label><div className="input-row"><input id="room" value={roomId} onChange={e => setRoomId(cleanRoomId(e.target.value))} placeholder="例如 A9K2MZ" autoComplete="off" /><button>加入</button></div></form></>}
    {isInSession && <><div className="room-panel"><span>房间号</span><strong>{roomId}</strong><button className="copy" onClick={copyRoom}>复制链接</button><button className="copy" onClick={reset}>离开</button></div><div className="status"><i className={status === '已连接' ? 'live' : ''} />{status}<em>{users.length} 位成员</em></div><div className="room-layout"><section className="content"><div className="screen-grid">{videoCards.length ? videoCards.map(card => <VideoTile key={card.id} card={card} user={users.find(user => user.id === card.id)} fullscreen={fullscreen} />) : <div className="empty-screen">还没有人共享屏幕<br /><small>点击下方按钮开始共享</small></div>}</div><button className={sharing ? 'stop-share' : 'primary'} onClick={toggleShare}>{sharing ? '停止共享我的屏幕' : '共享我的屏幕'}</button></section><aside className="sidebar"><section className="members"><h2>房间成员 <span>{users.length}</span></h2>{users.map(user => <div className="member" key={user.id}><i className={user.sharing ? 'live' : ''} /> <span>{user.name}{user.id === myIdRef.current ? '（我）' : ''}</span>{user.sharing && <small>共享中</small>}</div>)}</section><section className="chat"><h2>聊天室</h2><div className="messages">{chat.length ? chat.map(item => <p key={item.id} className={item.mine ? 'mine' : ''}><b>{item.mine ? '我' : item.name}</b>{item.text}</p>) : <p className="empty-chat">还没有消息</p>}</div><form onSubmit={sendChat}><input value={draft} maxLength={500} onChange={e => setDraft(e.target.value)} placeholder="说点什么…" /><button aria-label="发送消息">↑</button></form></section></aside></div></>}
    <p className="message">{message}</p>
  </section><p className="footnote">媒体通过端到端 WebRTC 传输；PeerJS 只用于建立连接。</p></main>
}

function VideoTile({ card, user, fullscreen }: { card: { id: string; stream: MediaStream; mine: boolean }; user?: RoomUser; fullscreen: (video: HTMLVideoElement | null) => void }) {
  const ref = useRef<HTMLVideoElement>(null)
  const [volume, setVolume] = useState(100)
  useEffect(() => { if (ref.current) ref.current.srcObject = card.stream }, [card.stream])
  function changeVolume(value: number) {
    setVolume(value)
    if (ref.current) ref.current.volume = value / 100
  }
  return <article className="video-tile"><video ref={ref} autoPlay playsInline muted={card.mine} /><div className="video-bar"><span>{card.mine ? '我的屏幕（本地静音）' : user?.name || '用户屏幕'}</span><div className="video-actions">{!card.mine && <label className="volume" title={`音量 ${volume}%`}><span>🔊</span><input aria-label={`${user?.name || '视频'}音量`} type="range" min="0" max="100" value={volume} onChange={event => changeVolume(Number(event.target.value))} /></label>}<button onClick={() => fullscreen(ref.current)}>全屏</button></div></div></article>
}

export default App
