"use client";

import { useState } from "react";
import { KeyRound, ShieldCheck, ShieldX } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PendingToolCall } from "@/lib/types";

const REQUEST_CREDENTIAL = "request_credential";

interface ToolApprovalBlockProps {
  toolCalls: PendingToolCall[];
  onApprove: (credentials?: Record<string, string>) => void;
  onReject: () => void;
  disabled?: boolean;
}

export function ToolApprovalBlock({
  toolCalls,
  onApprove,
  onReject,
  disabled,
}: ToolApprovalBlockProps) {
  const credentialCalls = toolCalls.filter((tc) => tc.name === REQUEST_CREDENTIAL);
  const needsCredential = credentialCalls.length > 0;

  const [credentials, setCredentials] = useState<Record<string, string>>({});

  const missingCredential = credentialCalls.some(
    (tc) => !credentials[tc.toolUseId] || credentials[tc.toolUseId].length === 0,
  );

  const handleSubmit = () => {
    onApprove(needsCredential ? credentials : undefined);
  };

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium text-amber-800">
        {needsCredential ? (
          <>
            <KeyRound className="size-4" />
            <span>자격증명 입력 요청</span>
          </>
        ) : (
          <>
            <ShieldCheck className="size-4" />
            <span>도구 실행 승인 요청</span>
          </>
        )}
      </div>

      <div className="space-y-2">
        {toolCalls.map((tc) => {
          if (tc.name === REQUEST_CREDENTIAL) {
            const key = String((tc.args as { key?: unknown }).key ?? "");
            const description = String((tc.args as { description?: unknown }).description ?? "");
            return (
              <div
                key={tc.toolUseId}
                className="space-y-1.5 bg-amber-100/40 rounded px-2 py-2"
              >
                <div className="text-xs text-amber-800">
                  <span className="font-semibold">{key}</span>
                  {description && (
                    <span className="text-amber-700/80"> — {description}</span>
                  )}
                </div>
                <input
                  type="password"
                  autoComplete="off"
                  disabled={disabled}
                  value={credentials[tc.toolUseId] ?? ""}
                  onChange={(e) =>
                    setCredentials((prev) => ({
                      ...prev,
                      [tc.toolUseId]: e.target.value,
                    }))
                  }
                  placeholder={`${key} 값을 입력`}
                  className="w-full rounded border border-amber-300 bg-white px-2 py-1 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-amber-400"
                />
              </div>
            );
          }
          return (
            <div
              key={tc.toolUseId}
              className="flex items-center gap-2 text-xs font-mono text-amber-700 bg-amber-100/50 rounded px-2 py-1.5"
            >
              <span className="font-semibold">{tc.name}</span>
              <span className="text-amber-600/70 truncate">
                ({Object.values(tc.args).map(String).join(", ")})
              </span>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={disabled || (needsCredential && missingCredential)}
          className="bg-emerald-600 hover:bg-emerald-700 text-white h-7 text-xs px-3"
        >
          <ShieldCheck className="size-3 mr-1" />
          {needsCredential ? "저장 후 진행" : "승인"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onReject}
          disabled={disabled}
          className="border-red-200 text-red-600 hover:bg-red-50 h-7 text-xs px-3"
        >
          <ShieldX className="size-3 mr-1" />
          거부
        </Button>
      </div>
    </div>
  );
}
