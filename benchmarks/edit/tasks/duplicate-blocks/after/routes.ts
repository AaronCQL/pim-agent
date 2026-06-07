function handleGet(): void {
  log("start");
  send(200);
  log("end");
}

function handlePost(): void {
  log("start");
  send(201);
  log("end");
}
