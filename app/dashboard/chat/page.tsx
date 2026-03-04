export default function ChatPage() {
  return (
    <div className="rounded-xl border border-dashed border-edge bg-panel/50 p-12 text-center">
      <div className="text-ink-faint text-3xl mb-3">AI</div>
      <h2 className="text-lg font-medium text-ink mb-2">Portfolio Chat</h2>
      <p className="text-ink-dim text-sm max-w-md mx-auto">
        Ask questions about your portfolio using Claude-powered Q&A. Requires an
        API key in <code className="text-gold font-mono text-xs">.env.local</code>.
      </p>
    </div>
  );
}
