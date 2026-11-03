import React, { useEffect, useRef, useState } from 'react';
import {
  Calendar, Captions, Check, ChevronDown, Circle, Copy, Facebook, Hand, Heart, Info,
  Instagram, Mail, MessageCircle, Mic, MicOff, MonitorUp, Music2, PhoneOff, Play,
  Settings, Share2, SlidersHorizontal, UserPlus, Users, Video,
  VideoOff, Volume2, X, Smile,
} from 'lucide-react';
import { AudioManager } from '../js/AudioManager.js';
import { WebRTCManager } from '../js/WebRTCManager.js';
import AudioConsole from './AudioConsole.jsx';

const REACTIONS = ['🙏', '❤️', '👏', '🙌', '🔥', '✨', '😊', '😂', '🎉', '💯', '👋', '🤍', '😇', '🥳', '💪', '🙌', '🎶', '🕊️'];

function initials(name = 'Guest') {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'G';
}

function Button({ children, label, active = false, danger = false, onClick, className = '', ...props }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl border px-3 text-sm font-medium transition hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-gold/70 ${danger ? 'border-red-400/40 bg-red-500/15 text-red-100 hover:bg-red-500/25' : active ? 'border-gold/70 bg-gold/15 text-gold' : 'border-white/10 bg-white/[0.06] text-white/80 hover:border-gold/40 hover:bg-white/[0.1]'} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

function AuthScreen({ error }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-obsidian px-5 py-10">
      <section className="w-full max-w-md rounded-3xl border border-white/10 bg-white/[0.045] p-8 text-center shadow-glow">
        <div className="mx-auto mb-5 grid h-16 w-16 place-items-center rounded-2xl bg-gold text-obsidian">
          <Music2 size={32} />
        </div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.3em] text-gold">Worship Room</p>
        <h1 className="text-3xl font-semibold text-white">Gather with purpose.</h1>
        <p className="mt-3 text-sm leading-6 text-white/60">Sign in with Google to create or join a verified worship room.</p>
        {error && <p className="mt-4 rounded-xl bg-red-500/10 p-3 text-sm text-red-200">{error}</p>}
        <a href="/auth/google" className="mt-7 inline-flex min-h-12 w-full items-center justify-center rounded-2xl bg-gold px-5 font-semibold text-obsidian transition hover:bg-yellow-300">
          Continue with Google
        </a>
      </section>
    </main>
  );
}

function LandingScreen({ user, onJoin }) {
  const [roomCode, setRoomCode] = useState('');
  const [name, setName] = useState(user?.name || '');
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduled, setScheduled] = useState(() => {
    try { return JSON.parse(localStorage.getItem('worship-scheduled-meeting') || 'null'); } catch { return null; }
  });
  const [title, setTitle] = useState('Worship Room');
  const [description, setDescription] = useState('Come, let us worship');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const createRoom = () => onJoin(crypto.randomUUID().slice(0, 8), name.trim() || user?.name || 'Host');
  const scheduleMeeting = (event) => {
    event.preventDefault();
    const meeting = {
      id: crypto.randomUUID().slice(0, 8),
      title: title.trim() || 'Worship Room',
      description: description.trim() || 'Come, let us worship',
      date,
      time,
      host: name.trim() || user?.name || 'Host',
    };
    localStorage.setItem('worship-scheduled-meeting', JSON.stringify(meeting));
    setScheduled(meeting);
    setScheduleOpen(false);
  };
  return (
    <main className="min-h-screen bg-obsidian px-5 py-6 text-white sm:px-10">
      <header className="mx-auto flex max-w-6xl items-center justify-between gap-4 border-b border-white/10 pb-5">
        <div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-gold text-obsidian"><Music2 size={21} /></span><strong>Worship Room</strong></div>
        <div className="flex items-center gap-2 text-sm text-white/60"><span className="grid h-9 w-9 place-items-center rounded-full bg-rose text-white">{initials(user?.name)}</span><span className="hidden sm:inline">{user?.name}</span></div>
      </header>
      <section className="mx-auto grid max-w-6xl gap-10 py-14 lg:grid-cols-[1.2fr_.8fr] lg:items-center">
        <div><p className="text-sm font-semibold uppercase tracking-[0.3em] text-gold">A room for every voice</p><h1 className="mt-4 max-w-2xl text-4xl font-semibold leading-tight sm:text-6xl">Make space for worship, wherever you are.</h1><p className="mt-6 max-w-xl text-lg leading-8 text-white/60">Start an instant room or join a meeting with a code. Your room stays private and host-controlled.</p></div>
        <div className="rounded-3xl border border-white/10 bg-white/[0.045] p-6 shadow-glow">
          <label className="text-sm text-white/70">Display name<input value={name} onChange={(event) => setName(event.target.value)} className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none focus:border-gold" maxLength={80} /></label>
          <Button label="Start instant meeting" onClick={createRoom} className="mt-5 w-full bg-gold text-obsidian hover:bg-yellow-300"><Play size={17} />Start instant meeting</Button>
          <Button label="Schedule meeting for later" onClick={() => setScheduleOpen(true)} className="mt-3 w-full"><Calendar size={17} />Schedule meeting for later</Button>
          <div className="my-5 flex items-center gap-3 text-xs text-white/40"><span className="h-px flex-1 bg-white/10" />OR<span className="h-px flex-1 bg-white/10" /></div>
          <label className="text-sm text-white/70">Meeting code or link<input value={roomCode} onChange={(event) => setRoomCode(event.target.value)} placeholder="e.g. 4f2a9c1d" className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none focus:border-gold" /></label>
          <Button label="Join meeting" onClick={() => roomCode.trim() && onJoin(roomCode.trim().split('/').pop(), name.trim() || user?.name || 'Guest')} className="mt-3 w-full"><Users size={17} />Join meeting</Button>
          {scheduled && <div className="mt-5 rounded-2xl border border-gold/30 bg-gold/10 p-4 text-left"><p className="text-xs uppercase tracking-widest text-gold">Scheduled meeting</p><p className="mt-2 font-semibold">{scheduled.title}</p><p className="mt-1 text-sm text-white/60">{scheduled.description}</p>{scheduled.date && <p className="mt-2 text-xs text-white/50">{scheduled.date}{scheduled.time ? ` at ${scheduled.time}` : ''}</p>}<Button label="Open scheduled meeting" onClick={() => onJoin(scheduled.id, scheduled.host)} className="mt-3 w-full bg-gold text-obsidian">Open meeting</Button></div>}
        </div>
      </section>
      {scheduleOpen && <div className="fixed inset-0 z-30 grid place-items-center bg-black/70 p-5"><form onSubmit={scheduleMeeting} className="w-full max-w-lg rounded-3xl border border-white/10 bg-[#1a171d] p-6 shadow-2xl"><div className="flex items-center justify-between"><div><p className="text-xs uppercase tracking-widest text-gold">Plan ahead</p><h2 className="mt-1 text-xl font-semibold">Schedule a worship meeting</h2></div><button type="button" aria-label="Close schedule dialog" onClick={() => setScheduleOpen(false)} className="rounded-lg p-2 text-white/60 hover:bg-white/10">×</button></div><label className="mt-5 block text-sm text-white/70">Room title<input value={title} onChange={(event) => setTitle(event.target.value)} className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none focus:border-gold" /></label><label className="mt-4 block text-sm text-white/70">Description<input value={description} onChange={(event) => setDescription(event.target.value)} className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none focus:border-gold" /></label><div className="mt-4 grid gap-4 sm:grid-cols-2"><label className="text-sm text-white/70">Date<input required type="date" value={date} onChange={(event) => setDate(event.target.value)} className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none focus:border-gold" /></label><label className="text-sm text-white/70">Time<input required type="time" value={time} onChange={(event) => setTime(event.target.value)} className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none focus:border-gold" /></label></div><Button type="submit" label="Save scheduled meeting" className="mt-6 w-full bg-gold text-obsidian hover:bg-yellow-300"><Calendar size={17} />Save scheduled meeting</Button></form></div>}
    </main>
  );
}

function ParticipantTile({ participant, muted, mediaRef, local = false, isHost, onMute, onRemove }) {
  const hasVideo = participant.video || Boolean(participant.stream?.getVideoTracks?.().length);
  const hasScreen = Boolean(participant.screenStream);
  
  useEffect(() => {
    if (mediaRef?.current && participant.stream) {
      mediaRef.current.srcObject = participant.stream;
      mediaRef.current.play?.().catch(() => {});
    }
  }, [mediaRef, participant.stream]);

  return (
    <article className="group relative min-h-[clamp(20rem,46vh,34rem)] overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-plum to-black/20">
      {/* Main Camera or Audio */}
      {participant.stream && (
        hasVideo ? 
          <video ref={mediaRef} autoPlay muted={local} playsInline className="absolute inset-0 h-full w-full object-cover" /> : 
          <audio ref={mediaRef} autoPlay muted={local} playsInline />
      )}
      
      {/* Screen Share Overlay (Takes priority if active) */}
      {hasScreen && (
        <video 
          autoPlay muted playsInline 
          className="absolute inset-0 z-10 h-full w-full object-contain bg-black"
          ref={el => { if (el) el.srcObject = participant.screenStream; }} 
        />
      )}

      {/* Avatar Fallback */}
      {!hasVideo && !hasScreen && (
        <div className="absolute inset-0 grid place-items-center">
          {participant.picture ? 
            <img src={participant.picture} alt={`${participant.name} profile`} className="h-24 w-24 rounded-full object-cover" /> : 
            <div className="grid h-20 w-20 place-items-center rounded-full bg-rose text-2xl font-semibold text-white">{initials(participant.name)}</div>
          }
        </div>
      )}

      {/* Host Controls (Hover) */}
      {isHost && !local && (
        <div className="absolute right-4 top-4 z-20 hidden gap-2 group-hover:flex">
          <button onClick={() => onMute(participant.id)} className="rounded-lg bg-black/70 p-2 text-white hover:text-gold" title="Mute Participant"><MicOff size={16} /></button>
          <button onClick={() => onRemove(participant.id)} className="rounded-lg bg-red-500/80 p-2 text-white hover:bg-red-600" title="Remove Participant"><UserMinus size={16} /></button>
        </div>
      )}

      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/80 to-transparent px-4 pb-3 pt-8 text-sm z-20">
        <span>{participant.name} {hasScreen && "(Presenting)"}</span>
        <span className="flex items-center gap-3">
          {muted && <MicOff size={15} className="text-red-300" />}
          {participant.raised && <Hand size={15} className="text-gold" />}
        </span>
      </div>
    </article>
  );
}


function VacantParticipantTile() {
  return <article className="relative flex min-h-[clamp(20rem,46vh,34rem)] items-center justify-center overflow-hidden rounded-2xl border border-dashed border-gold/30 bg-gold/[0.035] p-6 text-center">
    <div><div className="mx-auto grid h-20 w-20 place-items-center rounded-full border border-gold/30 bg-gold/10 text-3xl text-gold">+</div><h3 className="mt-5 text-lg font-medium text-white/80">Waiting for someone to join</h3><p className="mx-auto mt-2 max-w-xs text-sm leading-6 text-white/45">Invite another worshipper to fill this space in the room.</p></div>
  </article>;
}

function MeetingStage({ localName, localPicture, localStream, localVideoStream, participants, muted, localVideo, localRaised, localReaction, localMediaRef, isHost, onMute, onRemove }) {
  return <section className="min-h-0 flex-1 overflow-auto p-3 sm:p-5">
    <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 pb-4"><div><p className="text-xs uppercase tracking-[0.25em] text-gold">Live worship room</p><h2 className="mt-1 text-xl font-semibold text-white">Gathered together</h2></div><span className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-1 text-xs text-white/60">{participants.length + 1} participant{participants.length === 0 ? '' : 's'}</span></div>
    <div className={`mx-auto grid min-h-[min(70vh,44rem)] max-w-7xl gap-3 ${participants.length > 2 ? 'sm:grid-cols-2 lg:grid-cols-3' : 'lg:grid-cols-2'}`}>
      <ParticipantTile participant={{ name: `${localName} (You)`, picture: localPicture, stream: localVideo ? localVideoStream : localStream, video: localVideo, raised: localRaised, reaction: localReaction }} muted={muted} mediaRef={localMediaRef} local={true} />
      {participants.map((participant) => <ParticipantTile key={participant.id} participant={participant} muted={participant.muted} mediaRef={participant.audioRef} local={false} isHost={isHost} onMute={onMute} onRemove={onRemove} />)}
      {participants.length === 0 && <VacantParticipantTile />}
    </div>
  </section>;
}

function ControlBar({ micOn, cameraOn, captionsOn, sharing, handRaised, recording, onMic, onCamera, onCaptions, onShare, onHand, onRecord, onReact, onLeave }) {
  return <nav className="safe-bottom flex w-full flex-wrap items-center justify-center gap-2 border-t border-white/10 bg-obsidian/95 px-3 py-3 backdrop-blur-xl sm:gap-3">
    <Button label={micOn ? 'Mute microphone' : 'Unmute microphone'} active={!micOn} onClick={onMic}>{micOn ? <Mic /> : <MicOff />}<span className="hidden md:inline">{micOn ? 'Mute' : 'Unmute'}</span></Button>
    <Button label={cameraOn ? 'Turn camera off' : 'Turn camera on'} active={cameraOn} onClick={onCamera}>{cameraOn ? <Video /> : <VideoOff />}<span className="hidden md:inline">Camera</span></Button>
    <Button label={sharing ? 'Stop sharing' : 'Share screen'} active={sharing} onClick={onShare}>{<MonitorUp />}<span className="hidden md:inline">{sharing ? 'Stop share' : 'Present'}</span></Button>
    <Button label={handRaised ? 'Lower hand' : 'Raise hand'} active={handRaised} onClick={onHand}><Hand /><span className="hidden md:inline">Hand</span></Button>
    <Button label="Send reaction" onClick={onReact}><Heart /><span className="hidden md:inline">React</span></Button>
    <Button label={captionsOn ? 'Stop captions' : 'Start captions'} active={captionsOn} onClick={onCaptions}><Captions /><span className="hidden md:inline">Captions</span></Button>
    <Button label={recording ? 'Stop recording' : 'Record'} active={recording} onClick={onRecord}><Circle className={recording ? 'fill-red-400 text-red-400' : ''} /><span className="hidden md:inline">{recording ? 'Stop' : 'Record'}</span></Button>
    <Button label="Leave call" danger onClick={onLeave}><PhoneOff /><span className="hidden md:inline">Leave</span></Button>
  </nav>;
}

function SidePanel({ title, icon, children, onClose }) {
  return <aside className="fixed inset-0 z-30 flex items-end bg-black/60 sm:inset-auto sm:bottom-5 sm:right-5 sm:top-20 sm:w-96 sm:bg-transparent"><div className="max-h-[85vh] w-full overflow-auto rounded-t-3xl border border-white/10 bg-[#1a171d] p-5 shadow-2xl sm:rounded-3xl">{<div className="mb-5 flex items-center justify-between"><h3 className="flex items-center gap-2 font-semibold">{icon}{title}</h3><button aria-label={`Close ${title}`} onClick={onClose} className="rounded-lg p-2 text-white/60 hover:bg-white/10"><X size={18} /></button></div>}{children}</div></aside>;
}

function InvitePanel({ roomId, onClose, onCopy }) {
  const link = `${window.location.origin}/?room=${roomId}`;
  const encodedLink = encodeURIComponent(link);
  const encodedText = encodeURIComponent('Join my Worship Room meeting');
  const [email, setEmail] = useState('');
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await onCopy();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };
  return <SidePanel title="Invite people" icon={<UserPlus size={18} />} onClose={onClose}>
    <p className="text-sm leading-6 text-white/60">Share this room with people you want to worship with.</p>
    <div className="mt-4 flex gap-2"><input readOnly value={link} aria-label="Room invite link" className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/20 px-3 py-3 text-xs text-white/70" /><Button label="Copy room link" onClick={copy} className="shrink-0 bg-gold text-obsidian"><Copy size={16} />{copied ? 'Copied!' : 'Copy'}</Button></div>
    <div className="mt-5 grid grid-cols-4 gap-3">
      <a href={`https://wa.me/?text=${encodedText}%20${encodedLink}`} target="_blank" rel="noreferrer" aria-label="Share on WhatsApp" className="grid place-items-center rounded-2xl border border-green-400/30 bg-green-500/10 p-3 text-xs text-green-200"><MessageCircle size={20} />WhatsApp</a>
      <a href={`mailto:?subject=${encodedText}&body=${encodedLink}`} aria-label="Share by email" className="grid place-items-center rounded-2xl border border-white/10 bg-white/[0.05] p-3 text-xs text-white/75"><Mail size={20} />Email</a>
      <a href={`https://www.facebook.com/sharer/sharer.php?u=${encodedLink}`} target="_blank" rel="noreferrer" aria-label="Share on Facebook" className="grid place-items-center rounded-2xl border border-blue-400/30 bg-blue-500/10 p-3 text-xs text-blue-200"><Facebook size={20} />Facebook</a>
      <a href={`https://www.instagram.com/?url=${encodedLink}`} target="_blank" rel="noreferrer" aria-label="Share on Instagram" className="grid place-items-center rounded-2xl border border-pink-400/30 bg-pink-500/10 p-3 text-xs text-pink-200"><Instagram size={20} />Instagram</a>
    </div>
    <label className="mt-6 block text-sm text-white/70">Add by email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="friend@example.com" className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-3 text-sm text-white outline-none focus:border-gold" /></label>
    <Button label="Prepare email invitation" onClick={() => { if (email) window.location.href = `mailto:${email}?subject=${encodedText}&body=${encodedLink}`; }} className="mt-3 w-full"><Mail size={17} />Send invitation</Button>
  </SidePanel>;
}

function App() {
  const [user, setUser] = useState(undefined);
  const [authError, setAuthError] = useState('');
  const [room, setRoom] = useState(null);
  const [status, setStatus] = useState('idle');
  const [participants, setParticipants] = useState([]);
  const [messages, setMessages] = useState([]);
  const [message, setMessage] = useState('');
  const [panel, setPanel] = useState(null);
  const [micOn, setMicOn] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraStream, setCameraStream] = useState(null);
  const [captionsOn, setCaptionsOn] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [handRaised, setHandRaised] = useState(false);
  const [recording, setRecording] = useState(false);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [reaction, setReaction] = useState('');
  const [caption, setCaption] = useState('');
  const [notice, setNotice] = useState('');
  
  // NEW: State to track people waiting in the lobby
  const [admissionRequests, setAdmissionRequests] = useState([]);
  
  const managerRef = useRef(null);
  const audioRef = useRef(null);
  const localAudioRef = useRef(null);
  
  // Handle URL parsing on load
  useEffect(() => {
    fetch('/auth/me', { credentials: 'include' })
      .then((response) => response.json())
      .then((data) => {
        const loggedInUser = data.user || null;
        setUser(loggedInUser);
        
        if (loggedInUser) {
          const params = new URLSearchParams(window.location.search);
          const urlRoomCode = params.get('room');
          if (urlRoomCode && !room && !managerRef.current) {
            joinRoom(urlRoomCode, loggedInUser.name || 'Guest');
          }
        }
      })
      .catch(() => { 
        setAuthError('Unable to verify your session.'); 
        setUser(null); 
      });
  }, []);

  const resetRoom = () => { 
    managerRef.current?.leave(); 
    audioRef.current?.destroy(); 
    managerRef.current = null; 
    audioRef.current = null; 
    setRoom(null); 
    setParticipants([]); 
    setMessages([]); 
    setStatus('idle');
    setAdmissionRequests([]);
    window.history.replaceState({}, document.title, window.location.pathname);
  };

  const joinRoom = async (roomId, displayName) => {
    try {
      const audio = new AudioManager();
      await audio.init();
      await audio.attachMicrophone();
      const manager = new WebRTCManager();
      audioRef.current = audio; 
      managerRef.current = manager;
      
      manager.onStatusChange = (next, text) => { setStatus(next); setNotice(text); };
      manager.onCameraStarted = (stream) => setCameraStream(stream);
      manager.onCameraStopped = () => setCameraStream(null);
      manager.onPeerJoined = (id, stream, name) => setParticipants((current) => current.some((peer) => peer.id === id) ? current : [...current, { id, name: name || 'Guest', stream, muted: false, audioRef: { current: null } }]);
      manager.onRemoteStream = (id, stream) => { setParticipants((current) => current.map((peer) => peer.id === id ? { ...peer, stream, video: Boolean(stream.getVideoTracks?.().length) } : peer)); };
      manager.onPeerRenamed = (id, name) => setParticipants((current) => current.map((peer) => peer.id === id ? { ...peer, name } : peer));
      manager.onPeerLeft = (id) => setParticipants((current) => current.filter((peer) => peer.id !== id));
      manager.onPeerMuted = (id, muted) => setParticipants((current) => current.map((peer) => peer.id === id ? { ...peer, muted } : peer));
      manager.onRaiseHand = (item) => setParticipants((current) => current.map((peer) => peer.id === (item.peer_id || item.sender_id) ? { ...peer, raised: item.raised === true } : peer));
      manager.onChatMessage = (chat) => setMessages((current) => current.some((item) => item.id === chat.id) ? current : [...current, { ...chat, id: chat.id || `${chat.timestamp}-${chat.sender_name}`, timestamp: chat.timestamp || new Date().toISOString() }]);
      manager.onCaption = (item) => setCaption(item.is_final ? '' : item.text || '');
      manager.onReaction = (item) => {
        const peerId = item.peer_id || item.sender_id;
        if (peerId) {
          setParticipants((current) => current.map((peer) => peer.id === peerId ? { ...peer, reaction: item.emoji || '✨' } : peer));
          window.setTimeout(() => setParticipants((current) => current.map((peer) => peer.id === peerId ? { ...peer, reaction: '' } : peer)), 2200);
        }
      };

      // NEW: Screen share handlers go here!

      manager.onRemoteScreenShare = (id, stream) => setParticipants(c => c.map(p => p.id === id ? { ...p, screenStream: stream } : p));
      manager.onRemoteScreenShareStopped = (id) => setParticipants(c => c.map(p => p.id === id ? { ...p, screenStream: null } : p));

      
      // NEW: Listen for guests asking to join
      manager.onAdmissionRequest = (item) => {
        setAdmissionRequests((current) => [...current, item]);
      };
      
      manager.onRoomClosed = (text) => { setNotice(text); resetRoom(); };
      manager.onKicked = () => { setNotice('You were removed from this room.'); resetRoom(); };
      manager.onWaitingRoom = () => setStatus('waiting');
      
      await manager.join(roomId, audio, displayName);
      setRoom({ id: roomId, name: displayName });
      setMicOn(true);
      window.history.replaceState({}, document.title, `/?room=${roomId}`);
    } catch (error) {
      setNotice(error.message || 'Unable to join this room.');
      audioRef.current?.destroy(); 
      audioRef.current = null; 
      managerRef.current = null;
    }
  };

  // NEW: Function to admit or deny guests
  const handleAdmission = (targetId, admit) => {
    if (managerRef.current && typeof managerRef.current.sendAdmissionDecision === 'function') {
      managerRef.current.sendAdmissionDecision(targetId, admit);
    }
    setAdmissionRequests((current) => current.filter((req) => req.peer_id !== targetId));
  };

  const sendMessage = (event) => { event.preventDefault(); const text = message.trim(); if (!text || !managerRef.current) return; managerRef.current.sendChat(text); setMessage(''); };
  const sendEmojiAsChat = (emoji) => { managerRef.current?.sendChat(emoji); setEmojiPickerOpen(false); };
  const sendReaction = (emoji) => {
    managerRef.current?.sendReaction(emoji);
    setReaction(emoji);
    window.setTimeout(() => setReaction(''), 2200);
  };
  const togglePanel = (name) => setPanel((current) => current === name ? null : name);
  const copyRoom = async () => { await navigator.clipboard?.writeText(`${window.location.origin}/?room=${room.id}`); setNotice('Room link copied'); };

  if (user === undefined) return <div className="grid min-h-screen place-items-center bg-obsidian text-gold"><Music2 className="animate-pulse" /></div>;
  if (!user) return <AuthScreen error={authError} />;
  if (!room) return <LandingScreen user={user} onJoin={joinRoom} />;

  const toggleMic = () => { const next = !micOn; setMicOn(next); audioRef.current?.setMicrophoneEnabled(next); managerRef.current?.refreshLocalTrack?.(); };
  const toggleCamera = async () => { try { if (cameraOn) managerRef.current.stopCamera(); else await managerRef.current.startCamera(); setCameraOn(!cameraOn); } catch (error) { setNotice(error.message); } };
  const toggleShare = async () => { try { if (sharing) managerRef.current.stopScreenShare(); else await managerRef.current.startScreenShare(); setSharing(!sharing); } catch (error) { setNotice(error.message); } };
  const toggleCaptions = () => { setCaptionsOn(!captionsOn); setCaption(!captionsOn ? 'Captions enabled' : ''); };

return <div className="flex min-h-screen flex-col bg-obsidian text-white">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3 sm:px-6">
      <div className="flex items-center gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-gold text-obsidian"><Music2 size={18} /></span>
        <strong>Worship Room</strong>
        <span className="hidden rounded-full border border-white/10 px-3 py-1 text-xs text-white/50 sm:inline">#{room.id}</span>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        
        {/* NEW: Host-only check for the Worship Console */}
        {managerRef.current?.isHost && (
          <Button label="Open Worship Console" onClick={() => togglePanel('audio')}>
            <SlidersHorizontal size={17} />
            <span className="hidden sm:inline">Worship Console</span>
          </Button>
        )}
        
        <Button label="Invite people" onClick={() => togglePanel('invite')}><UserPlus size={17} /><span className="hidden sm:inline">Invite people</span></Button>
        <Button label="Room information" onClick={() => togglePanel('info')}><Info size={17} /></Button>
        <Button label="Open participants" onClick={() => togglePanel('people')}><Users size={17} /></Button>
        <Button label="Open chat" onClick={() => togglePanel('chat')}><MessageCircle size={17} /></Button>
      </div>
    </header>
    
<div className="flex min-h-0 flex-1 flex-col">
      <MeetingStage 
        localName={room.name} 
        localPicture={user.picture} 
        localStream={audioRef.current?.destinationNode?.stream} 
        localVideoStream={cameraStream} 
        participants={participants} 
        muted={!micOn} 
        localVideo={cameraOn} 
        localRaised={handRaised} 
        localReaction={reaction} 
        localMediaRef={localAudioRef}
        isHost={managerRef.current?.isHost}
        onMute={(id) => managerRef.current?.setPeerMuted(id, true)}
        onRemove={(id) => managerRef.current?.removePeer(id)} 
      />
      <ControlBar 
        micOn={micOn} 
        cameraOn={cameraOn} 
        captionsOn={captionsOn} 
        sharing={sharing} 
        handRaised={handRaised} 
        recording={recording} 
        onMic={toggleMic} 
        onCamera={toggleCamera} 
        onCaptions={toggleCaptions} 
        onShare={toggleShare} 
        onHand={() => { const next = !handRaised; setHandRaised(next); managerRef.current?.setHandRaised(next); }} 
        onRecord={() => setRecording(!recording)} 
        onReact={() => togglePanel('reactions')} 
        onLeave={resetRoom} 
      />
    </div>    
    {/* Host Admission Notification Overlay */}
    {admissionRequests.length > 0 && (
      <div className="fixed right-5 top-20 z-50 flex flex-col gap-3">
        {admissionRequests.map((req) => (
          <div key={req.peer_id} className="w-80 rounded-2xl border border-gold/30 bg-obsidian/95 p-4 shadow-2xl backdrop-blur-md">
            <p className="text-sm font-semibold text-white">{req.name || 'A guest'} wants to join</p>
            <div className="mt-3 flex gap-2">
              <Button label="Deny" danger onClick={() => handleAdmission(req.peer_id, false)} className="flex-1 py-2 text-xs">Deny</Button>
              <Button label="Admit" active onClick={() => handleAdmission(req.peer_id, true)} className="flex-1 bg-gold py-2 text-xs text-obsidian hover:bg-yellow-300">Admit</Button>
            </div>
          </div>
        ))}
      </div>
    )}

    {status && <div className="pointer-events-none fixed left-1/2 top-20 z-20 -translate-x-1/2 rounded-full border border-white/10 bg-black/50 px-4 py-2 text-xs text-white/70">{status === 'connected' ? 'Connected' : notice || status}</div>}
    {caption && <div className="fixed bottom-28 left-1/2 z-20 max-w-[90vw] -translate-x-1/2 rounded-xl bg-black/70 px-4 py-2 text-sm text-white">{caption}</div>}
    {panel === 'chat' && <SidePanel title="Room chat" icon={<MessageCircle size={18} />} onClose={() => setPanel(null)}><div className="chat-scroll space-y-3">{messages.map((item) => <div key={item.id} className="rounded-xl bg-white/[0.06] p-3"><div className="flex items-center justify-between gap-2"><p className="text-xs text-gold">{item.sender_name || 'Guest'}</p><time className="text-[10px] text-white/35">{item.timestamp ? new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</time></div><p className="mt-1 text-sm text-white/80">{item.text}</p></div>)}</div><form onSubmit={sendMessage} className="relative mt-5 flex gap-2"><input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Send a message" className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/20 px-3 py-3 text-sm outline-none focus:border-gold" /><Button type="button" label="Open emoji picker" onClick={() => setEmojiPickerOpen(!emojiPickerOpen)} className="px-3"><Smile size={18} /></Button><Button type="submit" label="Send message" className="bg-gold text-obsidian"><ChevronDown className="rotate-[-90deg]" size={17} /></Button>{emojiPickerOpen && <div className="emoji-picker-scroll absolute bottom-14 right-0 z-10 grid w-64 grid-cols-6 gap-1 rounded-2xl border border-white/10 bg-[#211d24] p-3 shadow-2xl">{REACTIONS.map((emoji) => <button type="button" key={emoji} aria-label={`Send ${emoji} in chat`} onClick={() => sendEmojiAsChat(emoji)} className="rounded-lg p-2 text-xl hover:bg-gold/15">{emoji}</button>)}</div>}</form></SidePanel>}
    {panel === 'invite' && <InvitePanel roomId={room.id} onClose={() => setPanel(null)} onCopy={copyRoom} />}
    {panel === 'people' && <SidePanel title="People in this room" icon={<Users size={18} />} onClose={() => setPanel(null)}><div className="space-y-2">{[{ id: 'local', name: `${room.name} (You)` }, ...participants].map((person) => <div key={person.id} className="flex items-center justify-between rounded-xl bg-white/[0.05] p-3"><span className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-full bg-rose text-xs">{initials(person.name)}</span>{person.name}</span>{person.id !== 'local' && <span className="text-xs text-white/40">{person.muted ? 'Muted' : 'Live'}</span>}</div>)}</div></SidePanel>}
    {panel === 'info' && <SidePanel title="Room information" icon={<Info size={18} />} onClose={() => setPanel(null)}><p className="text-sm text-white/60">Share this code with people you trust.</p><div className="mt-4 flex items-center justify-between rounded-xl bg-black/20 p-4 font-mono text-gold">{room.id}<button aria-label="Copy room code" onClick={copyRoom}><Copy size={17} /></button></div></SidePanel>}
    {panel === 'reactions' && <SidePanel title="Send a reaction" icon={<Heart size={18} />} onClose={() => setPanel(null)}><div className="emoji-picker-scroll grid grid-cols-3 gap-3">{REACTIONS.map((item) => <button key={item} aria-label={`Send ${item}`} onClick={() => { sendReaction(item); setPanel(null); }} className="rounded-2xl bg-white/[0.06] p-4 text-3xl hover:bg-gold/15">{item}</button>)}</div></SidePanel>}
    {panel === 'audio' && <AudioConsole audioManager={audioRef.current} onClose={() => setPanel(null)} />}
  </div>;
}

export default App;