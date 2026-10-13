export function GET() {
  return Response.json({ message: "Hello from a Next.js route", time: new Date().toISOString() });
}
