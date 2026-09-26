export function connectWebSocket(
  endpoint: string | URL,
  onMessage: (event: MessageEvent) => void,
): WebSocket {
  const socket = new WebSocket(endpoint);
  socket.addEventListener('message', onMessage);
  return socket;
}
