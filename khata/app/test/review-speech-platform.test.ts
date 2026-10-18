/**
 * Android speech-platform review (speech-native.ts against a mock of @capgo/capacitor-speech-recognition 8.3.2 that
 * replays the event order of SpeechRecognitionPlugin.java). R1 and R2 were reported as defects (the "(today)" tests
 * documented the old behaviour); both are fixed in speech-native.ts and the tests now pin the fixed behaviour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const plugin = vi.hoisted(() => {
  const state = {
    listeners: new Map<string, Set<(ev: unknown) => void>>(),
    sessionId: 0,
    startImpl: null as null | ((opts: Record<string, unknown>) => Promise<unknown>),
    startCalls: 0,
    stopCalls: 0,
  };
  const emit = (name: string, ev: unknown) => {
    for (const l of state.listeners.get(name) ?? []) l(ev);
  };
  const SpeechRecognition = {
    available: async () => ({ available: true }),
    checkPermissions: async () => ({ speechRecognition: 'granted' }),
    requestPermissions: async () => ({ speechRecognition: 'granted' }),
    addListener: async (name: string, fn: (ev: unknown) => void) => {
      if (!state.listeners.has(name)) state.listeners.set(name, new Set());
      state.listeners.get(name)!.add(fn);
      return { remove: async () => void state.listeners.get(name)!.delete(fn) };
    },
    start: async (opts: Record<string, unknown>) => {
      state.startCalls++;
      if (state.startImpl) return state.startImpl(opts);
      state.sessionId++;
      emit('listeningState', { state: 'startingListening', sessionId: state.sessionId, reason: 'userStart' });
      emit('listeningState', { state: 'started', sessionId: state.sessionId, reason: 'userStart', status: 'started' });
      return undefined;
    },
    stop: async () => {
      state.stopCalls++;
    },
  };
  return { state, emit, SpeechRecognition };
});

vi.mock('@capgo/capacitor-speech-recognition', () => ({ SpeechRecognition: plugin.SpeechRecognition }));

const { createNativeSpeech } = await import('../src/platform/speech-native');

const stopped = (reason: string) =>
  plugin.emit('listeningState', { state: 'stopped', sessionId: plugin.state.sessionId, reason, status: 'stopped' });

describe('review: speech-native busy flag after a bridge-level start() failure', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    plugin.state.startImpl = null;
    plugin.state.startCalls = 0;
    plugin.state.stopCalls = 0;
  });
  afterEach(() => vi.useRealTimers());

  // Capacitor rejects a call the native side never saw (plugin not registered, bridge error) without any
  // 'stopped' event. Before the fix listen() mapped that to START_FAILED but left nativeBusy = true (only
  // SPEECH_UNAVAILABLE / SPEECH_PERMISSION called markIdle()), so every later listen() sat in waitIdle() for
  // IDLE_WAIT_MS (2.5 s) before calling start(). Now any rejection without a 'startingListening' event marks idle.
  it('R1 (fixed): a start() that never left IDLE natively marks the adapter idle at once', async () => {
    const s = createNativeSpeech();
    plugin.state.startImpl = async () => {
      throw new Error('Plugin SpeechRecognition does not respond to method call "start"');
    };
    await expect(s.listen({ lang: 'ta-IN' })).rejects.toThrow('SPEECH_ERROR:START_FAILED');
    plugin.state.startImpl = null;
    const p = s.listen({ lang: 'ta-IN' });
    await vi.advanceTimersByTimeAsync(50);
    expect(plugin.state.startCalls).toBe(2); // no 2.5 s idle wait
    plugin.emit('partialResults', { matches: ['ramu 100'] });
    stopped('results');
    expect(await p).toEqual(['ramu 100']);
  });

  it('R1 (fixed): "already running" keeps the busy flag until the live native session reports stopped', async () => {
    const s = createNativeSpeech();
    plugin.state.startImpl = async () => {
      throw new Error('Speech recognition is already running.');
    };
    await expect(s.listen({ lang: 'ta-IN' })).rejects.toThrow('SPEECH_ERROR:BUSY');
    plugin.state.startImpl = null;
    const p = s.listen({ lang: 'ta-IN' });
    await vi.advanceTimersByTimeAsync(50);
    expect(plugin.state.startCalls).toBe(1); // waiting for the earlier native session
    plugin.emit('listeningState', { state: 'stopped', sessionId: 999, reason: 'userStop', status: 'stopped' });
    await vi.advanceTimersByTimeAsync(0);
    expect(plugin.state.startCalls).toBe(2); // idle again as soon as the plugin says so, not after IDLE_WAIT_MS
    plugin.emit('partialResults', { matches: ['sita 50'] });
    stopped('results');
    expect(await p).toEqual(['sita 50']);
  });
});

describe('review: session end with the plugin\'s DICTATION_MODE intent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    plugin.state.startImpl = null;
    plugin.state.startCalls = 0;
    plugin.state.stopCalls = 0;
  });
  afterEach(() => vi.useRealTimers());

  // buildRecognizerIntent() puts "android.speech.extra.DICTATION_MODE" = partialResults (true for this app), the
  // mode Gboard voice typing uses: Google may keep the session open across pauses instead of firing onResults after
  // the usual ~1 s end-of-speech silence. Before the fix the adapter had no stability cut-off, so when Google did
  // not end the session by itself the shopkeeper had to tap Done or wait for maxMs (12 s in the UI). Now the
  // adapter stops PARTIAL_SETTLE_MS (2.5 s) after the partial transcript last changed.
  it('R2 (fixed): stop ~2.5 s after the partial transcript last changed, well before maxMs', async () => {
    const s = createNativeSpeech();
    const p = s.listen({ lang: 'ta-IN', maxMs: 12_000 });
    await vi.advanceTimersByTimeAsync(0);
    plugin.emit('partialResults', { matches: ['ராமு 100 குடுத்தாச்சு'] });
    await vi.advanceTimersByTimeAsync(2400);
    expect(plugin.state.stopCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(plugin.state.stopCalls).toBe(1);
    // Google answers stopListening() with the final onResults list, then 'stopped'.
    plugin.emit('partialResults', { matches: ['ராமு 100 குடுத்தாச்சு', 'ராமு நூறு குடுத்தாச்சு'] });
    stopped('userStop');
    expect(await p).toEqual(['ராமு 100 குடுத்தாச்சு', 'ராமு நூறு குடுத்தாச்சு']);
    expect(plugin.state.stopCalls).toBe(1); // the final list after our stop() does not re-arm the timer
  });

  it('R2 (fixed): silence (no partial at all) is still ended only by maxMs', async () => {
    const s = createNativeSpeech();
    const p = s.listen({ lang: 'ta-IN', maxMs: 12_000 });
    await vi.advanceTimersByTimeAsync(11_900);
    expect(plugin.state.stopCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(plugin.state.stopCalls).toBe(1);
    stopped('userStop');
    expect(await p).toEqual([]);
  });
});
