import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
createApp().listen(port, () => console.log(`To-do API listening on http://localhost:${port}/api/todos`));
