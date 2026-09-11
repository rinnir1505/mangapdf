/**
 * 重い処理の途中でイベントループへ制御を返すためのユーティリティ。
 *
 * setTimeout(0) は使わない。ブラウザがバックグラウンドのタブでは
 * 最短 1 秒まで間引かれるため、50 ページ処理すると
 * それだけで 50 秒余計にかかってしまう。
 * MessageChannel のタスクはこの間引きを受けない。
 */

let channel: MessageChannel | null = null;

export function yieldToUI(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === 'function') return scheduler.yield();

  if (!channel) channel = new MessageChannel();
  const { port1, port2 } = channel;
  return new Promise((resolve) => {
    port1.onmessage = () => {
      port1.onmessage = null;
      resolve();
    };
    port2.postMessage(null);
  });
}
