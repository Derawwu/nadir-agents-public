import { useState } from 'react';

interface Props {
  content: string;
  className?: string;
}

export function CopyButton({ content, className }: Props) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      onClick={handleCopy}
      title="Copy to clipboard"
      className={`text-xs px-1.5 py-0.5 rounded border transition-colors
        ${copied
          ? 'border-green-500/30 text-green-400'
          : 'border-border text-gray-500 hover:text-accent hover:border-accent/40'
        } ${className ?? ''}`}
    >
      {copied ? '✓ Copied' : '⧉ Copy'}
    </button>
  );
}
