// One pending request per mounted, authorized player. Never reads the whole media object.
export function createVideoSeek(feedback: (kind: 'neutral' | 'success' | 'error', text: string) => void) {
    type Media = Pick<HTMLVideoElement, 'currentTime' | 'duration' | 'readyState' | 'seeking'>;
    let pending: { videoId: string; seconds: number; started: boolean; media: Media | null } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => { pending = null; clearTimeout(timer); };
    const fail = (text: string) => { clear(); feedback('error', text); };
    function ready(videoId: string, media: Media | null) {
        if (!pending || pending.videoId !== videoId || pending.started) return;
        if (!media || media.readyState < 1 || (pending.media !== null && pending.media !== media)) return;
        if (!Number.isFinite(media.duration) || pending.seconds > media.duration) {
            fail('时间点超出当前视频时长，未能定位。请修改后重试。'); return;
        }
        try {
            pending.media = media;
            pending.started = true;
            media.currentTime = pending.seconds;
            feedback('neutral', '正在定位，播放器完成跳转后会确认。');
        } catch { fail('未能跳转，请重试或手动定位。'); }
    }
    return {
        request(videoId: string, seconds: number, media: Media | null) {
            clear();
            if (!Number.isSafeInteger(seconds) || seconds < 0) { fail('时间点需为有效的非负整数秒。'); return; }
            pending = { videoId, seconds, started: false, media };
            feedback('neutral', '播放器暂未就绪，已保留定位请求，元数据就绪后重试。');
            timer = setTimeout(() => fail('定位等待超时，请再次点击时间点重试。'), 10_000);
            ready(videoId, media);
        },
        ready,
        seeked(videoId: string, media: Media | null) {
            if (!pending || !pending.started || pending.videoId !== videoId || !media || pending.media !== media || media.seeking !== false || !Number.isFinite(media.currentTime) || Math.abs(media.currentTime - pending.seconds) > 0.5) return;
            const seconds = pending.seconds;
            clear(); feedback('success', `播放器已定位到 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}。`);
        },
        clear,
        dispose: clear
    };
}
