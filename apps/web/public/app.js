/* global EventSource, FormData, crypto, document, fetch */
const api = "http://127.0.0.1:3001/v1";
const form = document.querySelector("#session-form");
const status = document.querySelector("#form-status");
const state = document.querySelector("#state");
const messages = document.querySelector("#messages");
const cancel = document.querySelector("#cancel");
let sessionId;
let stream;
const seen = new Map();
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  status.textContent = "Creating…";
  const data = new FormData(form);
  const payload = {
    botVersionIds: [data.get("botA"), data.get("botB")],
    idempotencyKey: crypto.randomUUID(),
    limits: {
      costLimitMicrounits: Number(data.get("cost")),
      currency: "USD",
      durationLimitMs: Number(data.get("duration")) * 1000,
      messageLimit: Number(data.get("messages")),
      totalTokenLimit: Number(data.get("tokens")),
    },
    scenarioVersionId: data.get("scenario"),
  };
  const response = await fetch(`${api}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    status.textContent = "Could not create the session.";
    return;
  }
  const session = await response.json();
  sessionId = session.id;
  status.textContent = "Session accepted.";
  cancel.hidden = false;
  watch(session.id);
});
cancel.addEventListener("click", async () => {
  if (sessionId)
    await fetch(`${api}/sessions/${sessionId}/cancel`, { method: "POST" });
});
function watch(id) {
  if (stream) stream.close();
  stream = new EventSource(`${api}/sessions/${id}/events`);
  const types = [
    "session.started",
    "message.chunk.appended",
    "message.completed",
    "session.limit_reached",
    "session.completed",
    "session.cancelled",
    "session.failed",
  ];
  for (const type of types)
    stream.addEventListener(type, (event) => render(JSON.parse(event.data)));
  stream.onerror = () => {
    state.textContent = "Reconnecting from the last durable event…";
  };
}
function render(event) {
  state.textContent = event.eventType.replaceAll(".", " · ");
  if (event.eventType === "message.chunk.appended") {
    let item = seen.get(event.payload.messageId);
    if (!item) {
      item = document.createElement("li");
      item.className = "message";
      const speaker = document.createElement("p");
      speaker.className = "speaker";
      speaker.textContent = `BOT · ${event.participantId}`;
      const content = document.createElement("p");
      content.className = "content";
      item.append(speaker, content);
      messages.append(item);
      seen.set(event.payload.messageId, item);
    }
    item.querySelector(".content").textContent += event.payload.text;
  }
  if (
    [
      "session.limit_reached",
      "session.completed",
      "session.cancelled",
      "session.failed",
    ].includes(event.eventType)
  ) {
    cancel.hidden = true;
    stream.close();
  }
}
