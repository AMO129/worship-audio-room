import React, { useEffect, useState } from 'react';
import { Check, FileAudio, Music2, Pause, Play, SlidersHorizontal, Volume2, X } from 'lucide-react';

const PRESETS = [
  { id: 'gentle', name: 'Gentle worship', detail: 'Warm keys · 72 BPM', synth: 'pad', notes: [130.81, 196, 261.63, 329.63] },
  { id: 'quiet', name: 'Quiet prayer', detail: 'Soft pads · No rhythm', synth: 'strings', notes: [146.83, 220, 293.66, 369.99] },
  { id: 'joyful', name: 'Joyful praise', detail: 'Bright band · 104 BPM', synth: 'piano', notes: [164.81, 246.94, 329.63, 392] },
];

const DECK = [
  { name: 'Deep Pad C Major', synth: 'pad', notes: [130.81, 164.81, 196, 261.63] },
  { name: 'Warm Strings G Major', synth: 'strings', notes: [196, 246.94, 293.66, 392] },
  { name: 'Cinematic Drone', synth: 'drone', notes: [65.41, 98, 130.81] },
  { name: 'Heavenly Choir', synth: 'choir', notes: [261.63, 329.63, 392, 523.25] },
  { name: 'Altar Piano', synth: 'piano', notes: [261.63, 329.63, 392, 523.25] },
];

function Toggle({ checked, onChange, label }) {
  return <button type="button" aria-label={label} aria-pressed={checked} onClick={() => onChange(!checked)} className={`relative h-7 w-12 rounded-full transition ${checked ? 'bg-gold' : 'bg-white/15'}`}><span className={`absolute top-1 h-5 w-5 rounded-full bg-white transition ${checked ? 'left-6' : 'left-1'}`} /></button>;
}

function AudioConsole({ audioManager, onClose }) {
  const [backgroundOn, setBackgroundOn] = useState(false);
  const [ducking, setDucking] = useState(true);
  const [selectedPreset, setSelectedPreset] = useState(PRESETS[0].id);
  const [playingDeck, setPlayingDeck] = useState('');
  const [musicLevel, setMusicLevel] = useState(0.7);
  const [voiceLevel, setVoiceLevel] = useState(1);
  const [ambienceLevel, setAmbienceLevel] = useState(0.5);
  const [uploadedTrack, setUploadedTrack] = useState(null);

  useEffect(() => () => {
    if (uploadedTrack?.url) URL.revokeObjectURL(uploadedTrack.url);
  }, [uploadedTrack?.url]);

  const playSound = async (sound) => {
    if (!audioManager) return;
    await audioManager.playProceduralPreset(sound.synth, sound.notes);
    setPlayingDeck(sound.name || sound.id);
    setBackgroundOn(true);
  };
  const toggleBackground = async (enabled) => {
    setBackgroundOn(enabled);
    if (!enabled) {
      audioManager?.pauseMusic?.();
      audioManager?.stopProceduralPreset?.();
      setPlayingDeck('');
      return;
    }
    await playSound(PRESETS.find((preset) => preset.id === selectedPreset) || PRESETS[0]);
  };
  const selectUpload = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (uploadedTrack?.url) URL.revokeObjectURL(uploadedTrack.url);
    setUploadedTrack({ name: file.name, url: URL.createObjectURL(file) });
  };
  const playUpload = () => {
    if (!uploadedTrack || !audioManager) return;
    audioManager.crossfadeTo(uploadedTrack.url);
    setPlayingDeck('uploaded');
    setBackgroundOn(true);
  };
  const stopAudio = () => {
    audioManager?.pauseMusic?.();
    audioManager?.stopProceduralPreset?.();
    setPlayingDeck('');
    setBackgroundOn(false);
  };

  return <aside className="fixed inset-0 z-40 flex items-end bg-black/70 sm:inset-auto sm:bottom-5 sm:right-5 sm:top-16 sm:w-[min(94vw,28rem)] sm:bg-transparent">
    <section className="max-h-[92vh] w-full overflow-y-auto rounded-t-3xl border border-white/10 bg-[#1a171d] p-5 shadow-2xl sm:rounded-3xl">
      <header className="flex items-start justify-between"><div><p className="flex items-center gap-2 text-xs uppercase tracking-[0.25em] text-gold"><SlidersHorizontal size={15} /> Worship Console</p><h2 className="mt-2 text-xl font-semibold">Shape the room sound</h2></div><button type="button" aria-label="Close Worship Console" onClick={onClose} className="rounded-xl p-2 text-white/60 hover:bg-white/10"><X size={18} /></button></header>
      <div className="mt-5 flex items-center justify-between rounded-2xl border border-gold/30 bg-gold/10 p-4"><div><p className="font-medium">Background sound</p><p className="mt-1 text-xs text-white/50">Play a gentle worship bed</p></div><Toggle checked={backgroundOn} onChange={toggleBackground} label="Toggle background sound" /></div>
      <div className="mt-5"><h3 className="text-sm font-semibold text-white/80">Sound presets</h3><div className="mt-3 grid gap-2">{PRESETS.map((preset) => <button type="button" key={preset.id} onClick={() => { setSelectedPreset(preset.id); playSound(preset); }} className={`flex items-center justify-between rounded-2xl border p-3 text-left ${selectedPreset === preset.id ? 'border-gold/70 bg-gold/15' : 'border-white/10 bg-white/[0.04]'}`}><span><span className="block text-sm font-medium">{preset.name}</span><span className="mt-1 block text-xs text-white/50">{preset.detail}</span></span>{selectedPreset === preset.id ? <Check size={17} className="text-gold" /> : <Play size={16} className="text-white/40" />}</button>)}</div></div>
      <div className="mt-5 space-y-4"><h3 className="text-sm font-semibold text-white/80">Mix levels</h3>{[['Background music', musicLevel, setMusicLevel, (value) => audioManager?.setMasterGain?.(value)], ['Speaker voice priority', voiceLevel, setVoiceLevel, (value) => audioManager?.setVoiceGain?.(value)], ['Room ambience', ambienceLevel, setAmbienceLevel, null]].map(([label, value, setter, apply]) => <label key={label} className="block text-xs text-white/60">{label}<span className="float-right text-gold">{Math.round(value * 100)}%</span><input type="range" min="0" max="1" step="0.01" value={value} onChange={(event) => { const next = Number(event.target.value); setter(next); apply?.(next); }} className="mt-2 w-full accent-gold" /></label>)}</div>
      <button type="button" onClick={() => { const next = !ducking; setDucking(next); audioManager?.setSmartDucking?.(next); }} className={`mt-5 flex w-full items-center justify-between rounded-2xl border p-4 text-left ${ducking ? 'border-gold/40 bg-gold/10' : 'border-white/10 bg-white/[0.04]'}`}><span><span className="block text-sm font-medium">Smart voice ducking</span><span className="mt-1 block text-xs text-white/50">Lower music automatically while someone speaks</span></span><Toggle checked={ducking} onChange={(next) => { setDucking(next); audioManager?.setSmartDucking?.(next); }} label="Toggle smart voice ducking" /></button>
      <div className="mt-6"><h3 className="flex items-center gap-2 text-sm font-semibold text-white/80"><Music2 size={16} className="text-gold" /> P&amp;W Music Deck</h3><div className="mt-3 grid grid-cols-2 gap-2">{DECK.map((sound) => <button type="button" key={sound.name} onClick={() => playingDeck === sound.name ? stopAudio() : playSound(sound)} className={`rounded-xl border p-3 text-left text-xs ${playingDeck === sound.name ? 'border-gold bg-gold/15 text-gold' : 'border-white/10 bg-white/[0.04] text-white/70'}`}><span className="flex items-center gap-2">{playingDeck === sound.name ? <Pause size={14} /> : <Volume2 size={14} />}{sound.name}</span></button>)}</div></div>
      <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.04] p-4"><h3 className="flex items-center gap-2 text-sm font-semibold text-white/80"><FileAudio size={16} className="text-gold" /> Your audio</h3><p className="mt-1 text-xs leading-5 text-white/50">Upload a local audio file. It plays through the same music bus, so smart voice ducking lowers it while someone speaks.</p><label className="mt-3 flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-gold/40 bg-gold/10 px-3 py-3 text-sm text-gold hover:bg-gold/15"><FileAudio size={16} />Choose audio file<input type="file" accept="audio/*" onChange={selectUpload} className="sr-only" /></label>{uploadedTrack && <div className="mt-3 flex items-center gap-2"><p className="min-w-0 flex-1 truncate text-xs text-white/70">{uploadedTrack.name}</p><Button type="button" label={playingDeck === 'uploaded' ? 'Stop uploaded audio' : 'Play uploaded audio'} onClick={playingDeck === 'uploaded' ? stopAudio : playUpload} className="shrink-0 bg-gold text-obsidian">{playingDeck === 'uploaded' ? <Pause size={15} /> : <Play size={15} />}</Button></div>}</div>
      <button type="button" onClick={stopAudio} className="mt-4 w-full rounded-xl border border-white/10 px-3 py-2 text-xs text-white/60 hover:border-gold/40 hover:text-white">Stop all background audio</button>
    </section>
  </aside>;
}

export default AudioConsole;
