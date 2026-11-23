import { useLayoutEffect } from 'react';
import { CircleAlert, Crosshair, Plus, RotateCw } from 'lucide-react';
import { parseTimeLabel, timeLabel } from './timepoints.js';

export function ReferenceTime({ value, input, measure, capture, error, disabled, canInsert, change, insert, close, inspect }) {
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [input]);
  const { duration, unavailable } = measure;
  const max = Math.floor(duration);
  const at = parseTimeLabel(value);
  const position = Number.isFinite(at) ? Math.max(0, Math.min(max, at)) : 0;
  const hint = duration ? '秒数、分:秒或时:分:秒'
    : unavailable ? '片长暂未读到，重试后可插入时间。' : '正在读取视频片长…';
  return (
    <div className="cue-fields" id="discussion-time-fields" role="group" aria-label="选择引用位置">
      <div className="cue-readout">
        <label htmlFor="discussion-time">视频时间</label>
        <input ref={input} id="discussion-time" type="text" placeholder="0:00" value={value}
          readOnly={disabled} autoComplete="off" spellCheck={false} maxLength={24}
          style={{ width: Math.min(8, Math.max(4, value.length)) + 0.35 + 'ch' }}
          aria-invalid={error ? true : undefined}
          aria-describedby={'cue-feedback' + (duration ? ' cue-length' : '')}
          onChange={(event) => change(event.target.value)} onBlur={inspect}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter') { event.preventDefault(); insert(); }
            if (event.key === 'Escape') { event.preventDefault(); close(); }
          }} />
        {duration > 0 && <span className="cue-duration" id="cue-length">
          <span aria-hidden="true">/</span><span className="sr">视频总时长 </span>{timeLabel(duration)}
        </span>}
      </div>
      <div className="cue-position">
        {duration > 0 && <input className="cue-scrubber" type="range" min={0} max={max} step={1}
          value={position} aria-label="拖动选择视频时间" aria-valuetext={timeLabel(position)}
          style={{ '--played': (max ? position / max * 100 : 0) + '%' }} disabled={disabled || max === 0}
          onChange={(e) => change(timeLabel(Number(e.target.value)))}
          onPointerUp={(e) => change(timeLabel(Number(e.currentTarget.value)))} />}
        <p className={'cue-feedback' + (error ? ' invalid' : '')} id="cue-feedback"
          role={error ? 'alert' : 'status'}>
          {error && <CircleAlert size={14} aria-hidden="true" />}{error || hint}
        </p>
      </div>
      {capture && <button className="cue-capture" type="button" disabled={disabled} onClick={() => {
        change(timeLabel(capture())); input.current?.focus(); input.current?.select();
      }}><Crosshair size={15} aria-hidden="true" />取当前时间</button>}
      {unavailable && <button className="cue-capture" type="button" onClick={() => measure.read(true)}>
        <RotateCw size={15} aria-hidden="true" />重试片长
      </button>}
      <button type="button" className="cue-insert" disabled={disabled || !canInsert} onClick={insert}>
        <span className="btn"><Plus size={15} aria-hidden="true" />插入时间</span>
      </button>
    </div>
  );
}
