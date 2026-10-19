/**
 * Speech platform layer: the scripted fake, the Web Speech adapter (against a mock SpeechRecognition) and the
 * Android adapter (against a mock of @capgo/capacitor-speech-recognition that replays the event sequences the
 * plugin's Java source emits).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSpeech } from '../src/platform/fake-speech';
import { alternativesFromResults, createWebSpeech, localRecognitionAvailable } from '../src/platform/speech-web';
import { SPEECH_PRIVACY_NOTE, cleanAlternatives, clampAlternatives } from '../src/platform/speech-common';

// ---------------------------------------------------------------- mock Capgo plugin

const plugin = vi.hoisted(() => {
  const state = {
    listeners: new Map<string, Set<(ev: unknown) => void>>(),
    sessionId: 0,
    available: true,
    permission: 'granted' as 'granted' | 'denied' | 'prompt',
    requestResult: 'granted' as 'granted' | 'denied' | 'prompt',
    startImpl: null as null | ((opts: Record<string, unknown>) => Promise<unknown>),
    stopImpl: null as null | (() => Promise<void>),
    startCalls: [] as Array<Record<string, unknown>>,
    stopCalls: 0,
  };
  const emit = (name: string, ev: unknown) => {
    for (const l of state.listeners.get(name) ?? []) l(ev);
  };
  const SpeechRecognition = {
    available: async () => ({ available: state.available }),
    checkPermissions: async () => ({ speechRecognition: state.permission }),
    requestPermissions: async () => {
      state.permission = state.requestResult;
      return { speechRecognition: state.permission };
    },
    addListener: async (name: string, fn: (ev: unknown) => void) => {
      if (!state.listeners.has(name)) state.listeners.set(name, new Set());
      state.listeners.get(name)!.add(fn);
      return { remove: async () => void state.listeners.get(name)!.delete(fn) };
    },
    start: async (opts: Record<string, unknown>) => {
      state.startCalls.push(opts);
      if (state.startImpl) return state.startImpl(opts);
      // Default: behave like the plugin with partialResults:true (resolve once listening started).
      state.sessionId++;
      emit('listeningState', { state: 'startingListening', sessionId: state.sessionId, reason: 'userStart' });
      emit('listeningState', { state: 'started', sessionId: state.sessionId, reason: 'userStart', status: 'started' });
      return undefined;
    },
    stop: async () => {
      state.stopCalls++;
      if (state.stopImpl) return state.stopImpl();
    },
  };
  return { state, emit, SpeechRecognition };
});

vi.mock('@capgo/capacitor-speech-recognition', () => ({ SpeechRecognition: plugin.SpeechRecognition }));

const { createNativeSpeech, mapStartError, biasList, BIAS_PHRASE_MAX_LEN, MAX_BIAS_PHRASES, PARTIAL_SETTLE_MS } = await import('../src/platform/speech-native');

const tick = () => new Promise((r) => setTimeout(r, 0));

function stopped(reason: string, errorCode?: string) {
  plugin.emit('listeningState', {
    state: 'stopped',
    sessionId: plugin.state.sessionId,
    reason,
    status: 'stopped',
    ...(errorCode ? { errorCode } : {}),
  });
}

describe('speech-common', () => {
  it('ships the privacy notice in both languages, naming Google and the Save confirmation', () => {
    for (const lang of ['en', 'ta'] as const) {
      expect(SPEECH_PRIVACY_NOTE[lang]).toContain('Google');
      expect(SPEECH_PRIVACY_NOTE[lang].length).toBeGreaterThan(80);
    }
    expect(SPEECH_PRIVACY_NOTE.en).toMatch(/tap Save/);
    expect(SPEECH_PRIVACY_NOTE.ta).toContain('சேமி');
  });

  it('cleans and caps alternatives', () => {
    expect(cleanAlternatives(['  ramu  100 ', 'ramu 100', '', 7, 'raamu 100', 'a', 'b', 'c'], 3)).toEqual([
      'ramu 100',
      'raamu 100',
      'a',
    ]);
    expect(cleanAlternatives(null, 5)).toEqual([]);
    expect(clampAlternatives(undefined)).toBe(5);
    expect(clampAlternatives(0)).toBe(1);
    expect(clampAlternatives(9)).toBe(5);
    expect(clampAlternatives(2.7)).toBe(2);
  });
});

describe('createFakeSpeech', () => {
  it('returns queued alternatives in order, emits word-by-word partials, then silence when empty', async () => {
    const script = [['ராமு 100 குடுத்தாச்சு', 'ராமு நூறு குடுத்தாச்சு'], ['Sita 50']];
    const s = createFakeSpeech(script, { delayMs: 20 });
    const partials: string[] = [];
    expect(await s.available()).toBe(true);
    expect(await s.ensurePermission()).toBe(true);
    const a = await s.listen({ lang: 'ta-IN', onPartial: (t) => partials.push(t), biasPhrases: ['ராமு'] });
    expect(a).toEqual(['ராமு 100 குடுத்தாச்சு', 'ராமு நூறு குடுத்தாச்சு']);
    expect(partials[0]).toBe('ராமு');
    expect(partials[partials.length - 1]).toBe('ராமு 100 குடுத்தாச்சு');
    expect(await s.listen({ lang: 'en-IN', maxAlternatives: 1 })).toEqual(['Sita 50']);
    expect(await s.listen({ lang: 'ta-IN' })).toEqual([]);
    expect(s.calls.map((c) => c.lang)).toEqual(['ta-IN', 'en-IN', 'ta-IN']);
    expect(s.calls[0].biasPhrases).toEqual(['ராமு']);
    expect(script).toEqual([]);
  });

  it('caps at maxAlternatives, supports error entries and live pushes', async () => {
    const script: string[][] = [['a', 'b', 'c'], ['!SPEECH_ERROR:NETWORK']];
    const s = createFakeSpeech(script, { delayMs: 0 });
    expect(await s.listen({ lang: 'ta-IN', maxAlternatives: 2 })).toEqual(['a', 'b']);
    await expect(s.listen({ lang: 'ta-IN' })).rejects.toThrow('SPEECH_ERROR:NETWORK');
    script.push(['later']);
    expect(await s.listen({ lang: 'ta-IN' })).toEqual(['later']);
  });

  it('stop() resolves early with the whole entry', async () => {
    const s = createFakeSpeech([['ramu 100 kuduthaachu']], { delayMs: 10_000 });
    const p = s.listen({ lang: 'ta-IN' });
    await s.stop();
    expect(await p).toEqual(['ramu 100 kuduthaachu']);
    expect(s.stopCount).toBe(1);
  });

  it('stop() with stopDelayMs delivers the result after that delay and ends the partials (hold-to-talk release)', async () => {
    const opts = { delayMs: 10_000, stopDelayMs: 40 };
    const s = createFakeSpeech([['ramu 100 kuduthaachu', 'ramu nooru kuduthaachu']], opts);
    const partials: string[] = [];
    const p = s.listen({ lang: 'ta-IN', onPartial: (t) => partials.push(t) });
    let settled = false;
    void p.then(() => (settled = true));
    await s.stop();
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(false);
    expect(await p).toEqual(['ramu 100 kuduthaachu', 'ramu nooru kuduthaachu']);
    expect(partials[partials.length - 1]).toBe('ramu 100 kuduthaachu');
    // a second stop() during the delay changes nothing; stopDelayMs 0 (default) resolves at once
    opts.stopDelayMs = 0;
    const q = s.listen({ lang: 'ta-IN' });
    await s.stop();
    expect(await q).toEqual([]);
    expect(s.stopCount).toBe(2);
  });

  it('reports unavailable and denied permission', async () => {
    const opts = { available: false, permission: false };
    const s = createFakeSpeech([['x']], opts);
    expect(await s.available()).toBe(false);
    await expect(s.listen({ lang: 'ta-IN' })).rejects.toThrow('SPEECH_UNAVAILABLE');
    opts.available = true;
    expect(await s.ensurePermission()).toBe(false);
    await expect(s.listen({ lang: 'ta-IN' })).rejects.toThrow('SPEECH_PERMISSION');
  });
});

// ---------------------------------------------------------------- Web Speech API

interface MockAlt {
  transcript: string;
  confidence: number;
}
type MockResult = MockAlt[] & { isFinal: boolean };
function result(isFinal: boolean, ...alts: string[]): MockResult {
  const r = alts.map((t) => ({ transcript: t, confidence: 0.8 })) as MockResult;
  r.isFinal = isFinal;
  return r;
}

class MockRecognition {
  static instances: MockRecognition[] = [];
  lang = '';
  continuous = true;
  interimResults = false;
  maxAlternatives = 1;
  phrases: unknown = undefined;
  started = false;
  onresult: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  constructor() {
    MockRecognition.instances.push(this);
  }
  start() {
    if (this.started) throw new Error('InvalidStateError');
    this.started = true;
  }
  stop() {
    // Like Chrome: deliver the pending final result, then end.
    setTimeout(() => {
      this.result([result(true, 'ramu 100')]);
      this.end();
    }, 0);
  }
  abort() {
    setTimeout(() => {
      this.onerror?.({ error: 'aborted' });
      this.end();
    }, 0);
  }
  result(results: MockResult[]) {
    this.onresult?.({ resultIndex: 0, results });
  }
  error(code: string) {
    this.onerror?.({ error: code });
  }
  end() {
    this.onend?.();
  }
}

class MockPhrase {
  constructor(
    public phrase: string,
    public boost = 1,
  ) {}
}

describe('createWebSpeech', () => {
  beforeEach(() => {
    MockRecognition.instances = [];
    vi.stubGlobal('window', { webkitSpeechRecognition: MockRecognition, isSecureContext: true });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const last = () => MockRecognition.instances[MockRecognition.instances.length - 1];

  it('is unavailable without the API (Firefox)', async () => {
    vi.stubGlobal('window', {});
    const s = createWebSpeech();
    expect(await s.available()).toBe(false);
    await expect(s.listen({ lang: 'ta-IN' })).rejects.toThrow('SPEECH_UNAVAILABLE');
  });

  it('configures the recogniser and returns the final alternatives, with interim partials', async () => {
    const s = createWebSpeech();
    expect(await s.available()).toBe(true);
    const partials: string[] = [];
    const p = s.listen({ lang: 'ta-IN', maxAlternatives: 3, onPartial: (t) => partials.push(t) });
    const rec = last();
    expect(rec.lang).toBe('ta-IN');
    expect(rec.continuous).toBe(false);
    expect(rec.interimResults).toBe(true);
    expect(rec.maxAlternatives).toBe(3);
    expect(rec.started).toBe(true);
    rec.result([result(false, 'ராமு')]);
    rec.result([result(true, 'ராமு 100 குடுத்தாச்சு', 'ராமு நூறு குடுத்தாச்சு', 'ராமு 100 குடுத்தாச்சு', 'x')]);
    rec.end();
    expect(await p).toEqual(['ராமு 100 குடுத்தாச்சு', 'ராமு நூறு குடுத்தாச்சு', 'x']);
    expect(partials).toEqual(['ராமு', 'ராமு 100 குடுத்தாச்சு']);
  });

  it('joins split results', () => {
    const results = [result(true, 'ramu'), result(true, '100 kuduthaachu', '100 kuduthaen')];
    expect(alternativesFromResults(results as never, 5)).toEqual(['ramu 100 kuduthaachu', 'ramu 100 kuduthaen']);
  });

  it('treats no-speech as silence and maps permission / other errors', async () => {
    const s = createWebSpeech();
    let p = s.listen({ lang: 'ta-IN' });
    last().error('no-speech');
    last().end();
    expect(await p).toEqual([]);

    p = s.listen({ lang: 'ta-IN' });
    last().error('not-allowed');
    last().end();
    await expect(p).rejects.toThrow('SPEECH_PERMISSION');

    p = s.listen({ lang: 'en-IN' });
    last().error('network');
    last().end();
    await expect(p).rejects.toThrow('SPEECH_ERROR:network');
  });

  it('stop() ends early and still resolves with the final result', async () => {
    const s = createWebSpeech();
    const p = s.listen({ lang: 'ta-IN' });
    await s.stop();
    expect(await p).toEqual(['ramu 100']);
  });

  it('a second listen() stops the first one before starting', async () => {
    const s = createWebSpeech();
    const p1 = s.listen({ lang: 'ta-IN' });
    const p2 = s.listen({ lang: 'ta-IN' });
    expect(await p1).toEqual(['ramu 100']);
    await tick();
    expect(MockRecognition.instances.length).toBe(2);
    last().result([result(true, 'sita 50')]);
    last().end();
    expect(await p2).toEqual(['sita 50']);
  });

  it('passes bias phrases where supported and retries once without them when rejected', async () => {
    vi.stubGlobal('window', {
      webkitSpeechRecognition: MockRecognition,
      SpeechRecognitionPhrase: MockPhrase,
      isSecureContext: true,
    });
    MockRecognition.instances = [];
    const s = createWebSpeech();
    const p = s.listen({ lang: 'ta-IN', biasPhrases: ['ராமு', '  ', 'சீதா'] });
    const first = last();
    expect((first.phrases as MockPhrase[]).map((x) => x.phrase)).toEqual(['ராமு', 'சீதா']);
    first.error('phrases-not-supported');
    first.end();
    const second = last();
    expect(second).not.toBe(first);
    expect(second.phrases).toBeUndefined();
    second.result([result(true, 'ராமு 100')]);
    second.end();
    expect(await p).toEqual(['ராமு 100']);
    // Never sent again on this page.
    const p2 = s.listen({ lang: 'ta-IN', biasPhrases: ['ராமு'] });
    expect(last().phrases).toBeUndefined();
    last().end();
    expect(await p2).toEqual([]);
  });

  it('feature-detects on-device recognition (Chrome 139+) and never requires it', async () => {
    expect(await localRecognitionAvailable('ta-IN')).toBe(false); // MockRecognition has no static available()
    vi.stubGlobal('window', {});
    expect(await localRecognitionAvailable('ta-IN')).toBe(false);
    class WithAvailable extends MockRecognition {
      static calls: unknown[] = [];
      static async available(o: unknown) {
        WithAvailable.calls.push(o);
        return 'available';
      }
    }
    vi.stubGlobal('window', { SpeechRecognition: WithAvailable });
    expect(await localRecognitionAvailable('ta-IN')).toBe(true);
    expect(WithAvailable.calls).toEqual([{ langs: ['ta-IN'], processLocally: true }]);
    class Throwing extends MockRecognition {
      static async available(): Promise<string> {
        throw new TypeError('bad options');
      }
    }
    vi.stubGlobal('window', { SpeechRecognition: Throwing });
    expect(await localRecognitionAvailable('ta-IN')).toBe(false);
    // listen() itself never sets processLocally.
    vi.stubGlobal('window', { SpeechRecognition: WithAvailable, isSecureContext: true });
    const s = createWebSpeech();
    const p = s.listen({ lang: 'ta-IN' });
    expect('processLocally' in last()).toBe(false);
    last().end();
    expect(await p).toEqual([]);
  });

  it('ignores bias phrases when the browser has no SpeechRecognitionPhrase', async () => {
    const s = createWebSpeech();
    const p = s.listen({ lang: 'ta-IN', biasPhrases: ['ராமு'] });
    expect(last().phrases).toBeUndefined();
    last().end();
    expect(await p).toEqual([]);
  });
});

// ---------------------------------------------------------------- Android (Capgo plugin)

describe('createNativeSpeech', () => {
  beforeEach(() => {
    plugin.state.startImpl = null;
    plugin.state.stopImpl = null;
    plugin.state.available = true;
    plugin.state.permission = 'granted';
    plugin.state.requestResult = 'granted';
    plugin.state.startCalls = [];
    plugin.state.stopCalls = 0;
  });

  it('starts inline with partial results and resolves with the final matches', async () => {
    const s = createNativeSpeech();
    const partials: string[] = [];
    const p = s.listen({ lang: 'ta-IN', onPartial: (t) => partials.push(t), biasPhrases: ['ராமு'] });
    await tick();
    await tick();
    expect(plugin.state.startCalls[0]).toEqual({ language: 'ta-IN', maxResults: 5, partialResults: true, popup: false, contextualStrings: ['ராமு'] });
    plugin.emit('partialResults', { matches: ['ராமு'] });
    plugin.emit('partialResults', { matches: ['ராமு 100'] });
    // Final onResults payload, then the session ends.
    plugin.emit('partialResults', { matches: ['ராமு 100 குடுத்தாச்சு', 'ராமு நூறு குடுத்தாச்சு', ' '] });
    stopped('results');
    expect(await p).toEqual(['ராமு 100 குடுத்தாச்சு', 'ராமு நூறு குடுத்தாச்சு']);
    expect(partials).toEqual(['ராமு', 'ராமு 100', 'ராமு 100 குடுத்தாச்சு']);
  });

  it('passes the customer names as contextualStrings (EXTRA_BIASING_STRINGS), deduped and capped; omits an empty list', async () => {
    const s = createNativeSpeech();
    let p = s.listen({ lang: 'ta-IN', biasPhrases: [' Ramu ', 'Kamala', 'Ramu', '', '  ', 'Kamala', 'ராமு  அண்ணன்'] });
    await tick();
    await tick();
    expect(plugin.state.startCalls[0].contextualStrings).toEqual(['Ramu', 'Kamala', 'ராமு அண்ணன்']);
    stopped('silence', 'NO_MATCH');
    expect(await p).toEqual([]);

    p = s.listen({ lang: 'ta-IN', biasPhrases: [] });
    await tick();
    await tick();
    expect('contextualStrings' in plugin.state.startCalls[1]).toBe(false);
    stopped('silence', 'NO_MATCH');
    expect(await p).toEqual([]);

    p = s.listen({ lang: 'ta-IN' });
    await tick();
    await tick();
    expect(plugin.state.startCalls[2]).toEqual({ language: 'ta-IN', maxResults: 5, partialResults: true, popup: false });
    stopped('silence', 'NO_MATCH');
    expect(await p).toEqual([]);

    const many = Array.from({ length: 260 }, (_, i) => `Name ${i}`);
    many.push('x'.repeat(150));
    expect(biasList(many)).toHaveLength(MAX_BIAS_PHRASES);
    expect(biasList(['x'.repeat(150)])[0]).toHaveLength(BIAS_PHRASE_MAX_LEN);
    // the cap counts code points: a name of 100 emoji keeps all 100, and one of 101 is never cut inside a pair
    expect(Array.from(biasList(['😀'.repeat(101)])[0])).toHaveLength(BIAS_PHRASE_MAX_LEN);
    expect(biasList(['😀'.repeat(BIAS_PHRASE_MAX_LEN)])[0]).toBe('😀'.repeat(BIAS_PHRASE_MAX_LEN));
    expect(biasList([1, null, 'a'] as unknown[])).toEqual(['a']);
    expect(biasList(undefined)).toEqual([]);
  });

  it('resolves [] on silence and rejects SPEECH_ERROR:<code> on errors', async () => {
    const s = createNativeSpeech();
    let p = s.listen({ lang: 'ta-IN' });
    await tick();
    await tick();
    plugin.emit('error', { code: 'NO_MATCH', message: 'No match', sessionId: plugin.state.sessionId });
    stopped('silence', 'NO_MATCH');
    expect(await p).toEqual([]);

    p = s.listen({ lang: 'ta-IN', maxAlternatives: 2 });
    await tick();
    await tick();
    expect(plugin.state.startCalls[1].maxResults).toBe(2);
    plugin.emit('partialResults', { matches: ['ராமு'] });
    plugin.emit('error', { code: 'NETWORK', message: 'Network error', sessionId: plugin.state.sessionId });
    stopped('error', 'NETWORK');
    await expect(p).rejects.toThrow('SPEECH_ERROR:NETWORK');
  });

  it('ignores events from another session', async () => {
    const s = createNativeSpeech();
    const p = s.listen({ lang: 'ta-IN' });
    await tick();
    await tick();
    plugin.emit('error', { code: 'NETWORK', message: 'x', sessionId: plugin.state.sessionId - 1 });
    plugin.emit('listeningState', { state: 'stopped', sessionId: plugin.state.sessionId - 1, reason: 'error' });
    plugin.emit('partialResults', { matches: ['sita 50'] });
    stopped('results');
    expect(await p).toEqual(['sita 50']);
  });

  it('stop() resolves with what was heard, via the plugin or the JS fallback', async () => {
    const s = createNativeSpeech();
    plugin.state.stopImpl = async () => {
      plugin.emit('partialResults', { matches: ['ramu 100 kuduthaachu', 'ramu 100 kuduthen'] });
      stopped('userStop');
    };
    let p = s.listen({ lang: 'ta-IN' });
    await tick();
    await tick();
    plugin.emit('partialResults', { matches: ['ramu 100'] });
    await s.stop();
    expect(await p).toEqual(['ramu 100 kuduthaachu', 'ramu 100 kuduthen']);

    vi.useFakeTimers();
    try {
      plugin.state.stopImpl = async () => undefined; // plugin never reports 'stopped'
      p = s.listen({ lang: 'ta-IN' });
      await vi.advanceTimersByTimeAsync(0);
      plugin.emit('partialResults', { matches: ['sita'] });
      await s.stop();
      await vi.advanceTimersByTimeAsync(1600);
      expect(await p).toEqual(['sita']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves with what was heard when Google answers our stop() with an error (ERROR_CLIENT)', async () => {
    const s = createNativeSpeech();
    plugin.state.stopImpl = async () => {
      // Real plugin sequence after stopListening() on many phones: onError(CLIENT) -> finishSession('userStop').
      plugin.emit('error', { code: 'CLIENT', message: 'Client side error', sessionId: plugin.state.sessionId });
      plugin.emit('listeningState', { state: 'stoppingListening', sessionId: plugin.state.sessionId, reason: 'userStop' });
      stopped('userStop', 'CLIENT');
    };
    const p = s.listen({ lang: 'ta-IN' });
    await tick();
    await tick();
    plugin.emit('partialResults', { matches: ['ramu 100'] });
    await s.stop();
    expect(await p).toEqual(['ramu 100']);

    // An error that happened BEFORE stop() is still reported.
    plugin.state.stopImpl = async () => stopped('userStop');
    const p2 = s.listen({ lang: 'ta-IN' });
    await tick();
    await tick();
    plugin.emit('error', { code: 'NETWORK', message: 'Network error', sessionId: plugin.state.sessionId });
    await s.stop();
    await expect(p2).rejects.toThrow('SPEECH_ERROR:NETWORK');
  });

  it('stops by itself after maxMs', async () => {
    vi.useFakeTimers();
    try {
      const s = createNativeSpeech();
      plugin.state.stopImpl = async () => stopped('userStop');
      const p = s.listen({ lang: 'ta-IN', maxMs: 3000 });
      await vi.advanceTimersByTimeAsync(2900);
      expect(plugin.state.stopCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(100);
      expect(plugin.state.stopCalls).toBe(1);
      expect(await p).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends a DICTATION_MODE session PARTIAL_SETTLE_MS after the transcript last changed', async () => {
    vi.useFakeTimers();
    try {
      const s = createNativeSpeech();
      plugin.state.stopImpl = async () => {
        plugin.emit('partialResults', { matches: ['ராமு 100 குடுத்தாச்சு', 'ராமு நூறு குடுத்தாச்சு'] });
        stopped('userStop');
      };
      const partials: string[] = [];
      const p = s.listen({ lang: 'ta-IN', onPartial: (t) => partials.push(t), maxMs: 12_000 });
      await vi.advanceTimersByTimeAsync(0);
      plugin.emit('partialResults', { matches: ['ராமு'] });
      await vi.advanceTimersByTimeAsync(2000);
      plugin.emit('partialResults', { matches: ['ராமு 100'] }); // change: timer re-armed
      await vi.advanceTimersByTimeAsync(2000);
      plugin.emit('partialResults', { matches: ['ராமு 100'] }); // same text: not re-armed
      await vi.advanceTimersByTimeAsync(400);
      expect(plugin.state.stopCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(PARTIAL_SETTLE_MS - 2400);
      expect(plugin.state.stopCalls).toBe(1);
      expect(await p).toEqual(['ராமு 100 குடுத்தாச்சு', 'ராமு நூறு குடுத்தாச்சு']);
      expect(partials).toEqual(['ராமு', 'ராமு 100', 'ராமு 100', 'ராமு 100 குடுத்தாச்சு']);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(plugin.state.stopCalls).toBe(1); // nothing left armed after the session settled
    } finally {
      vi.useRealTimers();
    }
  });

  it('hold-to-talk: a held session is never ended by the settle timer; setHeld(false) (a short press) arms it; maxMs still caps', async () => {
    vi.useFakeTimers();
    try {
      const s = createNativeSpeech();
      plugin.state.stopImpl = async () => {
        plugin.emit('partialResults', { matches: ['ராமு 100'] });
        stopped('userStop');
      };
      let p = s.listen({ lang: 'ta-IN', held: true, maxMs: 12_000 });
      await vi.advanceTimersByTimeAsync(0);
      plugin.emit('partialResults', { matches: ['ராமு'] });
      await vi.advanceTimersByTimeAsync(PARTIAL_SETTLE_MS * 2);
      expect(plugin.state.stopCalls).toBe(0); // the shopkeeper is thinking of the amount, finger still on the mic
      plugin.emit('partialResults', { matches: ['ராமு 100'] });
      await vi.advanceTimersByTimeAsync(PARTIAL_SETTLE_MS * 2);
      expect(plugin.state.stopCalls).toBe(0);
      await s.stop(); // release
      expect(plugin.state.stopCalls).toBe(1);
      expect(await p).toEqual(['ராமு 100']);

      // a short press is a tap after all: from then on the transcript settling ends the session
      p = s.listen({ lang: 'ta-IN', held: true, maxMs: 12_000 });
      await vi.advanceTimersByTimeAsync(0);
      plugin.emit('partialResults', { matches: ['sita' ] });
      await vi.advanceTimersByTimeAsync(1000);
      s.setHeld!(false);
      await vi.advanceTimersByTimeAsync(PARTIAL_SETTLE_MS - 10);
      expect(plugin.state.stopCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(10);
      expect(plugin.state.stopCalls).toBe(2);
      expect(await p).toEqual(['ராமு 100']);
      s.setHeld!(false); // no live session: nothing happens

      // maxMs caps a held session too
      p = s.listen({ lang: 'ta-IN', held: true, maxMs: 3000 });
      await vi.advanceTimersByTimeAsync(0);
      plugin.emit('partialResults', { matches: ['kamala' ] });
      await vi.advanceTimersByTimeAsync(2990);
      expect(plugin.state.stopCalls).toBe(2);
      await vi.advanceTimersByTimeAsync(10);
      expect(plugin.state.stopCalls).toBe(3);
      expect(await p).toEqual(['ராமு 100']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a stop() while listen() is still waiting for the previous native session resolves that listen() with [] without starting (hold released early)', async () => {
    vi.useFakeTimers();
    try {
      const s = createNativeSpeech();
      plugin.state.stopImpl = async () => undefined; // the plugin is slow to report 'stopped'
      const p1 = s.listen({ lang: 'ta-IN' });
      await vi.advanceTimersByTimeAsync(0);
      await s.stop();
      await vi.advanceTimersByTimeAsync(1500); // STOP_FALLBACK_MS: p1 resolves, native still busy
      expect(await p1).toEqual([]);
      const started = plugin.state.startCalls.length;

      const p2 = s.listen({ lang: 'ta-IN', held: true });
      await vi.advanceTimersByTimeAsync(10); // waiting for idle
      await s.stop(); // the finger left during the wait
      stopped('userStop'); // the previous native session ends: the wait is over
      await vi.advanceTimersByTimeAsync(10);
      expect(await p2).toEqual([]);
      expect(plugin.state.startCalls.length).toBe(started); // never started a session nobody was speaking into

      // the adapter is usable again, and a stop() before a listen() does not poison that listen()
      plugin.state.stopImpl = async () => stopped('userStop');
      await s.stop();
      const p3 = s.listen({ lang: 'ta-IN' });
      await vi.advanceTimersByTimeAsync(10);
      expect(plugin.state.startCalls.length).toBe(started + 1);
      plugin.emit('partialResults', { matches: ['ravi 20'] });
      await s.stop();
      expect(await p3).toEqual(['ravi 20']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not arm the settle timer after a user stop(), and clears it when Google ends the session first', async () => {
    vi.useFakeTimers();
    try {
      const s = createNativeSpeech();
      plugin.state.stopImpl = async () => undefined; // plugin reports nothing until we say so
      let p = s.listen({ lang: 'ta-IN', maxMs: 12_000 });
      await vi.advanceTimersByTimeAsync(0);
      plugin.emit('partialResults', { matches: ['sita'] });
      await s.stop();
      expect(plugin.state.stopCalls).toBe(1);
      plugin.emit('partialResults', { matches: ['sita 50'] }); // final list after our stop
      stopped('userStop');
      expect(await p).toEqual(['sita 50']);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(plugin.state.stopCalls).toBe(1);

      p = s.listen({ lang: 'ta-IN', maxMs: 12_000 });
      await vi.advanceTimersByTimeAsync(0);
      plugin.emit('partialResults', { matches: ['kamala'] });
      await vi.advanceTimersByTimeAsync(1000);
      plugin.emit('partialResults', { matches: ['kamala 200'] });
      stopped('results'); // Google ended the session by itself
      expect(await p).toEqual(['kamala 200']);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(plugin.state.stopCalls).toBe(1); // settle timer was cleared with the session
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks the adapter idle after a bridge-level start() rejection, but not after "already running"', async () => {
    vi.useFakeTimers();
    try {
      const s = createNativeSpeech();
      plugin.state.startImpl = async () => {
        throw new Error('Plugin SpeechRecognition does not respond to method call "start"');
      };
      await expect(s.listen({ lang: 'ta-IN' })).rejects.toThrow('SPEECH_ERROR:START_FAILED');
      plugin.state.startImpl = null;
      let p = s.listen({ lang: 'ta-IN' });
      await vi.advanceTimersByTimeAsync(10);
      expect(plugin.state.startCalls).toHaveLength(2);
      stopped('results');
      expect(await p).toEqual([]);

      plugin.state.startImpl = async () => {
        throw new Error('Speech recognition is already running.');
      };
      await expect(s.listen({ lang: 'ta-IN' })).rejects.toThrow('SPEECH_ERROR:BUSY');
      plugin.state.startImpl = null;
      p = s.listen({ lang: 'ta-IN' });
      await vi.advanceTimersByTimeAsync(10);
      expect(plugin.state.startCalls).toHaveLength(3); // still waiting for the live native session
      plugin.emit('listeningState', { state: 'stopped', sessionId: 42, reason: 'userStop', status: 'stopped' });
      await vi.advanceTimersByTimeAsync(10);
      expect(plugin.state.startCalls).toHaveLength(4);
      stopped('results');
      expect(await p).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps start() rejections', async () => {
    const s = createNativeSpeech();
    plugin.state.startImpl = async () => {
      throw Object.assign(new Error('Speech recognition service is not available.'), { code: 'UNAVAILABLE' });
    };
    await expect(s.listen({ lang: 'ta-IN' })).rejects.toThrow('SPEECH_UNAVAILABLE');
    plugin.state.startImpl = async () => {
      throw new Error('Missing permission');
    };
    await expect(s.listen({ lang: 'ta-IN' })).rejects.toThrow('SPEECH_PERMISSION');
    expect(mapStartError(new Error('Speech recognition is already running.')).message).toBe('SPEECH_ERROR:BUSY');
    expect(mapStartError(new Error('boom')).message).toBe('SPEECH_ERROR:START_FAILED');
  });

  it('available() and ensurePermission()', async () => {
    const s = createNativeSpeech();
    expect(await s.available()).toBe(true);
    plugin.state.available = false;
    expect(await s.available()).toBe(false);
    expect(await s.ensurePermission()).toBe(true);
    plugin.state.permission = 'prompt';
    plugin.state.requestResult = 'denied';
    expect(await s.ensurePermission()).toBe(false);
    plugin.state.requestResult = 'granted';
    expect(await s.ensurePermission()).toBe(true);
  });
});

// ---------------------------------------------------------------- web platform wiring

describe('createWebPlatform().speech', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the scripted fake when window.__KK_FAKE_SPEECH__ is set, reading the array live', async () => {
    const script: string[][] = [];
    const win: Record<string, unknown> = { __KK_FAKE_SPEECH__: script, __KK_FAKE_SPEECH_OPTIONS__: { delayMs: 0 } };
    vi.stubGlobal('window', win);
    const { createWebPlatform } = await import('../src/platform/web');
    const p = createWebPlatform();
    script.push(['ராமு 100 குடுத்தாச்சு']);
    expect(await p.speech.listen({ lang: 'ta-IN' })).toEqual(['ராமு 100 குடுத்தாச்சு']);
    expect(p.speech).toBe(p.speech);
  });

  it('stops the session when the tab is hidden', async () => {
    const script: string[][] = [['ramu 100 kuduthaachu']];
    const handlers: Array<() => void> = [];
    const doc = { visibilityState: 'visible', addEventListener: (_n: string, fn: () => void) => handlers.push(fn) };
    vi.stubGlobal('window', { __KK_FAKE_SPEECH__: script, __KK_FAKE_SPEECH_OPTIONS__: { delayMs: 10_000 } });
    vi.stubGlobal('document', doc);
    const { createWebPlatform } = await import('../src/platform/web');
    const p = createWebPlatform();
    const result = p.speech.listen({ lang: 'ta-IN' });
    expect(handlers.length).toBe(1);
    doc.visibilityState = 'hidden';
    handlers[0]();
    expect(await result).toEqual(['ramu 100 kuduthaachu']);
  });

  it('uses the Web Speech API otherwise', async () => {
    vi.stubGlobal('window', {});
    const { createWebPlatform } = await import('../src/platform/web');
    expect(await createWebPlatform().speech.available()).toBe(false);
  });
});

