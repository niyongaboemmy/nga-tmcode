export const metadata = { title: "Next.js app" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui", maxWidth: 640, margin: "3rem auto" }}>{children}</body>
    </html>
  );
}
