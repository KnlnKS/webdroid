// android.widget.VideoView: a SurfaceView whose MediaPlayer opens once the surface exists, in
// AOSP's state machine (the target state applies when the player becomes prepared).

import { rt, JObj, driven, type Gen } from "../jvm/runtime";
import { vcall, after } from "../jvm/natives/jlang";
import { requestLayout, invalidate, specMode, specSize, MS_EXACTLY, MS_AT_MOST } from "./view";
import { onMain } from "./mainloop";
import { JSurfaceView, getHolder, viewInit } from "./glview";
import { JMediaPlayer, mpReset, mpStart } from "./media";
import { mkUri, type JUri } from "./net";

const ERROR = -1, IDLE = 0, PREPARING = 1, PREPARED = 2, PLAYING = 3, PAUSED = 4, COMPLETED = 5;
class JVideoView extends JSurfaceView {
  uri: JUri | null = null;
  mp: JMediaPlayer | null = null;
  state = IDLE; target = IDLE;
  seekWhenPrepared = 0;
  videoW = 0; videoH = 0;
  preparedL: unknown = null; completionL: unknown = null; errorL: unknown = null; infoL: unknown = null;
  controller: unknown = null;
  playing(): boolean { return !!this.mp && this.state !== ERROR && this.state !== IDLE && this.state !== PREPARING; }
  ensureSurface(): void {
    const created = !getHolder(this).surface;
    super.ensureSurface();
    if (created && getHolder(this).surface) void onMain(() => this.open());
  }
  destroySurface(): void {
    this.release(true);
    super.destroySurface();
  }
  release(clearTarget: boolean): void {
    if (this.mp) { mpReset(this.mp); this.mp = null; }
    this.state = IDLE;
    if (clearTarget) this.target = IDLE;
  }
  open(): unknown { return rt.drive(this.open$()); }
  *open$(): Gen {
    const holder = getHolder(this);
    if (!this.uri || !holder.surface) return;
    this.release(false);
    const mp = this.mp = rt.make("android/media/MediaPlayer") as JMediaPlayer;
    const listener = new JVideoListener(this);
    mp.display = holder;
    mp.preparedL = mp.completionL = mp.errorL = mp.sizeL = listener;
    try {
      yield vcall(mp, "setDataSource", "(Landroid/content/Context;Landroid/net/Uri;)V", this.ctx, this.uri);
      yield vcall(mp, "prepareAsync", "()V");
      this.state = PREPARING;
    } catch (e) {
      yield vcall(listener, "onError", "(Landroid/media/MediaPlayer;II)Z", mp, 1, 0);
      if (!this.errorL) throw e;
    }
  }
  sized(mp: JMediaPlayer): void {
    const el = mp.media as HTMLVideoElement;
    if (el.videoWidth === this.videoW && el.videoHeight === this.videoH) return;
    this.videoW = el.videoWidth; this.videoH = el.videoHeight;
    requestLayout(this);
  }
  *prepared$(mp: JMediaPlayer): Gen {
    if (mp !== this.mp) return;
    this.state = PREPARED;
    if (this.preparedL) yield vcall(this.preparedL, "onPrepared", "(Landroid/media/MediaPlayer;)V", mp);
    this.sized(mp);
    if (this.seekWhenPrepared) { mp.media!.currentTime = this.seekWhenPrepared / 1000; this.seekWhenPrepared = 0; }
    if (this.target === PLAYING) { mpStart(mp); this.state = PLAYING; }
  }
  prepared(mp: JMediaPlayer): unknown { return rt.drive(this.prepared$(mp)); }
  setUri(uri: JUri | null): void {
    this.uri = uri; this.seekWhenPrepared = 0;
    void onMain(() => this.open());
    requestLayout(this); invalidate(this);
  }
}
/** VideoView's listener on its player (AOSP's mPreparedListener and siblings), which moves the
 *  state machine and forwards to the app's listeners */
class JVideoListener extends JObj {
  constructor(readonly view: JVideoView) { super(); }
}
rt.register({
  name: "webdroid/VideoViewListener", ctor: JVideoListener,
  ifaces: ["android/media/MediaPlayer$OnPreparedListener", "android/media/MediaPlayer$OnCompletionListener",
    "android/media/MediaPlayer$OnErrorListener", "android/media/MediaPlayer$OnVideoSizeChangedListener"],
  methods: {
    "onPrepared(Landroid/media/MediaPlayer;)V": function (this: JVideoListener, mp: JMediaPlayer) { return this.view.prepared(mp); },
    "onCompletion(Landroid/media/MediaPlayer;)V": function (this: JVideoListener, mp: JMediaPlayer) {
      const v = this.view;
      v.state = v.target = COMPLETED;
      if (v.completionL) return vcall(v.completionL, "onCompletion", "(Landroid/media/MediaPlayer;)V", mp);
    },
    "onError(Landroid/media/MediaPlayer;II)Z": function (this: JVideoListener, mp: JMediaPlayer, what: number, extra: number) {
      const v = this.view;
      v.state = v.target = ERROR;
      return after(v.errorL ? vcall(v.errorL, "onError", "(Landroid/media/MediaPlayer;II)Z", mp, what, extra) : 0, () => 1);
    },
    "onVideoSizeChanged(Landroid/media/MediaPlayer;II)V": function (this: JVideoListener, mp: JMediaPlayer) { this.view.sized(mp); },
  },
});
/** VideoView.onMeasure: the video's aspect ratio within what the parent allows */
function measure(this: JVideoView, wSpec: number, hSpec: number) {
  const vw = this.videoW, vh = this.videoH, wMode = specMode(wSpec), hMode = specMode(hSpec);
  let w = wMode ? specSize(wSpec) : vw, h = hMode ? specSize(hSpec) : vh;
  if (vw > 0 && vh > 0) {
    if (wMode === MS_EXACTLY && hMode === MS_EXACTLY) {
      if (vw * h < w * vh) w = Math.trunc(h * vw / vh); else if (vw * h > w * vh) h = Math.trunc(w * vh / vw);
    } else if (wMode === MS_EXACTLY) {
      h = Math.trunc(w * vh / vw);
      if (hMode === MS_AT_MOST && h > specSize(hSpec)) h = specSize(hSpec);
    } else if (hMode === MS_EXACTLY) {
      w = Math.trunc(h * vw / vh);
      if (wMode === MS_AT_MOST && w > specSize(wSpec)) w = specSize(wSpec);
    } else {
      w = vw; h = vh;
      if (hMode === MS_AT_MOST && h > specSize(hSpec)) { h = specSize(hSpec); w = Math.trunc(h * vw / vh); }
      if (wMode === MS_AT_MOST && w > specSize(wSpec)) { w = specSize(wSpec); h = Math.trunc(w * vh / vw); }
    }
  }
  this.measuredW = w; this.measuredH = h;
}
rt.register({
  name: "android/widget/VideoView", ctor: JVideoView, sup: "android/view/SurfaceView",
  ifaces: ["android/widget/MediaController$MediaPlayerControl"],
  methods: {
    "<init>(Landroid/content/Context;)V": viewInit,
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": viewInit,
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;I)V": viewInit,
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;II)V": viewInit,
    "onMeasure(II)V": measure,
    "setVideoPath(Ljava/lang/String;)V": function (this: JVideoView, path: string) { this.setUri(mkUri(path)); },
    "setVideoURI(Landroid/net/Uri;)V": function (this: JVideoView, uri: JUri | null) { this.setUri(uri); },
    "setVideoURI(Landroid/net/Uri;Ljava/util/Map;)V": function (this: JVideoView, uri: JUri | null) { this.setUri(uri); },
    "start()V": function (this: JVideoView) {
      if (this.playing()) { mpStart(this.mp!); this.state = PLAYING; }
      this.target = PLAYING;
    },
    "pause()V": function (this: JVideoView) {
      if (this.playing() && !this.mp!.media!.paused) { this.mp!.media!.pause(); this.state = PAUSED; }
      this.target = PAUSED;
    },
    "stopPlayback()V": function (this: JVideoView) { this.release(true); },
    "suspend()V": function (this: JVideoView) { this.release(false); },
    "resume()V": driven(function* (this: JVideoView): Gen { yield this.open(); }),
    "seekTo(I)V": function (this: JVideoView, ms: number) {
      if (this.playing()) { this.mp!.media!.currentTime = ms / 1000; this.seekWhenPrepared = 0; } else this.seekWhenPrepared = ms;
    },
    "isPlaying()Z": function (this: JVideoView) { return +(this.playing() && !this.mp!.media!.paused); },
    "getDuration()I": function (this: JVideoView) { return this.playing() ? vcall(this.mp, "getDuration", "()I") : -1; },
    "getCurrentPosition()I": function (this: JVideoView) { return this.playing() ? Math.round(this.mp!.media!.currentTime * 1000) : 0; },
    "getBufferPercentage()I": function (this: JVideoView) {
      const el = this.mp?.media;
      return el && el.buffered.length && el.duration ? Math.round(100 * el.buffered.end(el.buffered.length - 1) / el.duration) : 0;
    },
    "canPause()Z": () => 1, "canSeekBackward()Z": () => 1, "canSeekForward()Z": () => 1,
    "getAudioSessionId()I": () => 1,
    "setOnPreparedListener(Landroid/media/MediaPlayer$OnPreparedListener;)V": function (this: JVideoView, l: unknown) { this.preparedL = l; },
    "setOnCompletionListener(Landroid/media/MediaPlayer$OnCompletionListener;)V": function (this: JVideoView, l: unknown) { this.completionL = l; },
    "setOnErrorListener(Landroid/media/MediaPlayer$OnErrorListener;)V": function (this: JVideoView, l: unknown) { this.errorL = l; },
    "setOnInfoListener(Landroid/media/MediaPlayer$OnInfoListener;)V": function (this: JVideoView, l: unknown) { this.infoL = l; },
    "setMediaController(Landroid/widget/MediaController;)V": function (this: JVideoView, c: unknown) { this.controller = c; },
    "setAudioFocusRequest(I)V": () => {},
    "setAudioAttributes(Landroid/media/AudioAttributes;)V": () => {},
  },
});
rt.markers("android/widget/MediaController$MediaPlayerControl");
