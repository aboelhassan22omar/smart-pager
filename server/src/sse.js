const HEARTBEAT_MS = 25_000;

// Takes over the raw response and returns a tiny SSE writer.
export function openSse(request, reply) {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const cleanups = [];
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  request.raw.on('close', () => {
    clearInterval(heartbeat);
    for (const fn of cleanups) fn();
  });

  return {
    send(event, data) {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    onClose(fn) {
      cleanups.push(fn);
    },
  };
}
