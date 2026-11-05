import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Button, ScrollView, StatusBar, StyleSheet, Text, TextInput, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

// Keep these high-level types aligned with lib/live2d/types.ts in the web host.
type SpeakerId = 'interviewer-1' | 'interviewer-2';
type SpeechIdentity = { turnId: string; speakerId: SpeakerId };
type Command =
  | { type: 'prepare' | 'pause' | 'resume' | 'dispose' }
  | ({ type: 'speak'; audioUrl: string } & SpeechIdentity)
  | { type: 'cancel'; turnId: string }
  | { type: 'setListening'; listening: boolean };
type SceneEvent =
  | { type: 'ready'; mode: 'live2d' | 'static-fallback' }
  | ({ type: 'speechStarted' | 'speechEnded' | 'speechCancelled' } & SpeechIdentity)
  | { type: 'stateChanged'; state: string }
  | { type: 'error'; code: string; message: string };
const channel = 'each-answer-scene-v1';
const configuredOrigin = process.env.EXPO_PUBLIC_SCENE_ORIGIN?.trim() ?? '';

function resolveScene() {
  if (!configuredOrigin) return null;
  try {
    const url = new URL(configuredOrigin);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    // Paths and query parameters belong to the scene endpoint, never to the origin setting.
    if (url.pathname !== '/' || url.search || url.hash) return null;
    return { origin: url.origin, uri: new URL('/interview/scene', url.origin).href };
  } catch { return null; }
}

export default function App() {
  const scene = resolveScene();
  const webview = useRef<WebView<object>>(null);
  // This nonce isolates one mounted bridge session. It is not an authentication secret.
  const sessionId = useRef(`scene-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  const sequence = useRef(0), active = useRef<SpeechIdentity | null>(null);
  const mounted = useRef(true), loaded = useRef(false);
  const [audioPath, setAudioPath] = useState('');
  const [ready, setReady] = useState(false), [status, setStatus] = useState('장면을 불러오고 있어요.');
  const [mode, setMode] = useState<'live2d' | 'static-fallback' | null>(null);
  const [interrupted, setInterrupted] = useState(false);

  const send = useCallback((command: Command) => {
    if (!webview.current || !loaded.current) return;
    const payload = JSON.stringify({ channel, sessionId: sessionId.current, sequence: ++sequence.current, command });
    // JSON encode twice: the first encodes the envelope; the second safely embeds it as a JS string.
    const literal = JSON.stringify(payload).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    webview.current.injectJavaScript(`window.dispatchEvent(new MessageEvent('message', { data: ${literal} })); true;`);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') { send({ type: 'pause' }); setInterrupted(true); }
      // Foregrounding never resumes interview audio without an explicit user action.
    });
    return () => {
      send({ type: 'dispose' });
      mounted.current = false;
      subscription.remove();
    };
  }, [send]);

  const onMessage = (message: WebViewMessageEvent) => {
    if (!mounted.current || !scene) return;
    // Ignore events from another document, an old WebView, or a previous bridge session.
    try {
      if (new URL(message.nativeEvent.url).origin !== scene.origin) return;
      if (message.nativeEvent.data.length > 16_384) return;
      const envelope = JSON.parse(message.nativeEvent.data) as { channel?: unknown; sessionId?: unknown; event?: SceneEvent };
      if (envelope.channel !== channel || envelope.sessionId !== sessionId.current || !envelope.event) return;
      const event = envelope.event;
      if (event.type === 'ready' && (event.mode === 'live2d' || event.mode === 'static-fallback')) {
        setReady(true); setMode(event.mode);
        setStatus(event.mode === 'live2d' ? '면접 장면이 준비되었어요.' : '정적 대체 이미지입니다. Live2D 모델이 연결되지 않았어요.');
      } else if (event.type === 'error' && typeof event.message === 'string') {
        setStatus(event.message);
      } else if (event.type === 'speechStarted' && event.turnId === active.current?.turnId && event.speakerId === active.current.speakerId) {
        setStatus(event.speakerId === 'interviewer-1' ? '남성 면접관이 질문하고 있어요.' : '여성 면접관이 질문하고 있어요.');
      } else if ((event.type === 'speechEnded' || event.type === 'speechCancelled') && event.turnId === active.current?.turnId && event.speakerId === active.current.speakerId) {
        active.current = null;
        setStatus(event.type === 'speechEnded' ? '질문 음성 재생이 끝났어요.' : '질문 음성을 중단했어요.');
      } else if (event.type === 'stateChanged' && event.state === 'listening') {
        setStatus('학생 답변을 경청하고 있어요.');
      }
    } catch { /* Unrelated or malformed messages never mutate scene state. */ }
  };

  const speak = (speakerId: SpeakerId) => {
    if (!scene || !ready) return;
    try {
      const audio = new URL(audioPath.trim(), scene.origin);
      if (!audioPath.trim() || audio.origin !== scene.origin || audio.username || audio.password || !['https:', 'http:'].includes(audio.protocol)) throw new Error('same_origin_audio_required');
      const identity = { speakerId, turnId: `turn-${Date.now()}-${++sequence.current}` };
      active.current = identity;
      send({ type: 'speak', ...identity, audioUrl: audio.href });
      setStatus('음성을 준비하고 있어요.');
    } catch { setStatus('장면 서버와 같은 출처의 실제 음성 주소를 입력해 주세요.'); }
  };

  if (!scene) return <View style={styles.configuration}><Text style={styles.title}>각자의답 · 면접 장면</Text><Text style={styles.body}>EXPO_PUBLIC_SCENE_ORIGIN에 기기에서 접근할 수 있는 장면 서버 주소를 설정한 뒤 앱을 다시 시작해 주세요.</Text><Text style={styles.detail}>예: https://interview.example.com</Text></View>;
  return <View style={styles.root}>
    <StatusBar barStyle="light-content" />
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text accessibilityRole="header" style={styles.title}>각자의답 · 면접 장면</Text>
      <Text accessibilityLiveRegion="polite" style={styles.body}>{status}</Text>
      {mode === 'static-fallback' && <Text style={styles.notice}>모델 미연결 · 정적 대체 화면</Text>}
      <View style={styles.scene}>
        <WebView<object>
          ref={webview}
          source={{ uri: scene.uri }}
          originWhitelist={[scene.origin]}
          onShouldStartLoadWithRequest={request => {
            try { return new URL(request.url).origin === scene.origin; } catch { return false; }
          }}
          onLoadStart={() => { loaded.current = false; sessionId.current = `scene-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; sequence.current = 0; setReady(false); setMode(null); active.current = null; }}
          onLoadEnd={() => { loaded.current = true; send({ type: 'prepare' }); }}
          onMessage={onMessage}
          onError={() => { setReady(false); setStatus('장면 서버에 연결하지 못했어요. 연결 상태를 확인해 주세요.'); }}
          onHttpError={({ nativeEvent }) => { setReady(false); setStatus(`장면 서버 응답을 확인해 주세요. (${nativeEvent.statusCode})`); }}
          onContentProcessDidTerminate={() => { setReady(false); loaded.current = false; setStatus('장면이 종료되었어요. 장면을 새로 불러와 주세요.'); }}
          onRenderProcessGone={() => { setReady(false); loaded.current = false; setStatus('장면이 종료되었어요. 장면을 새로 불러와 주세요.'); }}
          javaScriptEnabled
          javaScriptCanOpenWindowsAutomatically={false}
          setSupportMultipleWindows={false}
          allowFileAccess={false}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          mixedContentMode="never"
          thirdPartyCookiesEnabled={false}
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          allowsPictureInPictureMediaPlayback={false}
          scrollEnabled={false}
          bounces={false}
          style={styles.webview}
        />
      </View>
      <Text style={styles.label}>실제 면접관 출력 음성 주소</Text>
      <TextInput value={audioPath} onChangeText={setAudioPath} style={styles.input} autoCapitalize="none" autoCorrect={false} placeholder="/api/audio/실제-음성-ID" placeholderTextColor="#8c8c8c" accessibilityLabel="장면 서버의 음성 주소" />
      <View style={styles.row}><Button title="남성 질문 재생" onPress={() => speak('interviewer-1')} disabled={!ready || interrupted} /><Button title="여성 질문 재생" onPress={() => speak('interviewer-2')} disabled={!ready || interrupted} /></View>
      <View style={styles.row}><Button title="일시정지" disabled={!ready} onPress={() => { send({ type: 'pause' }); setInterrupted(true); }} /><Button title="이어서 재생" disabled={!ready} onPress={() => { send({ type: 'resume' }); setInterrupted(false); }} /><Button title="질문 취소" disabled={!ready} onPress={() => { if (active.current) send({ type: 'cancel', turnId: active.current.turnId }); }} /></View>
      <View style={styles.row}><Button title="학생 답변 경청" disabled={!ready} onPress={() => send({ type: 'setListening', listening: true })} /><Button title="질문 대기" disabled={!ready} onPress={() => send({ type: 'setListening', listening: false })} /></View>
      <View style={styles.row}><Button title="장면 준비 다시 시도" onPress={() => send({ type: 'prepare' })} /><Button title="장면 새로 불러오기" onPress={() => webview.current?.reload()} /></View>
      <Text style={styles.detail}>이 예제는 장면 연결 확인용입니다. 학생 카메라·녹음·전사·분석은 기존 앱에서 연결해야 합니다. 음성 재생과 입 모양 분석은 WebView 안에서 처리하며 매 프레임 앱으로 전달하지 않습니다.</Text>
    </ScrollView>
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#171717' },
  content: { padding: 18, paddingTop: 52, paddingBottom: 40, gap: 16 },
  configuration: { flex: 1, padding: 24, paddingTop: 70, gap: 20, backgroundColor: '#171717' },
  title: { color: '#f5f5f5', fontSize: 21, fontWeight: '600' },
  body: { color: '#d2d2d2', fontSize: 14, lineHeight: 22 },
  detail: { color: '#aaa', fontSize: 12, lineHeight: 20 },
  notice: { color: '#edc8a4', fontSize: 12 },
  label: { color: '#ddd', fontSize: 13 },
  scene: { width: '100%', aspectRatio: 16 / 9, overflow: 'hidden', borderRadius: 12, backgroundColor: '#242424' },
  webview: { flex: 1, backgroundColor: '#242424' },
  input: { color: '#f5f5f5', borderColor: '#494949', borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 12 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
});
