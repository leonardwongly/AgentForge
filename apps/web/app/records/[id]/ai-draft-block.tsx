"use client";

import React, { useState } from "react";
import { Sparkles, Copy, Check } from "lucide-react";

interface AiDraftBlockProps {
  evidenceId: string;
  draftText: string;
}

export function AiDraftBlock({ evidenceId, draftText }: AiDraftBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleUseDraft = () => {
    // Locate the target textarea
    const textarea = document.getElementById(
      `evidence-content-${evidenceId}`
    ) as HTMLTextAreaElement | null;
    if (textarea) {
      textarea.value = draftText;
      // Trigger native input event so any listeners/validations are updated
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.focus();
    }

    // Try to copy to clipboard for extra developer convenience
    if (navigator.clipboard) {
      navigator.clipboard.writeText(draftText).catch(() => {});
    }

    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="ai-draft-container">
      <div className="ai-draft-header">
        <div className="ai-draft-title-row">
          <Sparkles size={16} className="ai-sparkles-icon" aria-hidden="true" />
          <span className="ai-draft-title">AI Advisory Draft Plan</span>
        </div>
        <span className="ai-badge">Advisory</span>
      </div>
      <div className="ai-draft-body">
        <pre className="ai-draft-pre">{draftText}</pre>
      </div>
      <div className="ai-draft-actions">
        <button
          type="button"
          onClick={handleUseDraft}
          className={`ai-draft-btn ${copied ? "ai-draft-btn--success" : ""}`}
          aria-label="Use AI Draft suggestion"
        >
          {copied ? (
            <>
              <Check size={14} aria-hidden="true" />
              Applied & Copied!
            </>
          ) : (
            <>
              <Copy size={14} aria-hidden="true" />
              Use AI Draft
            </>
          )}
        </button>
      </div>
    </div>
  );
}
