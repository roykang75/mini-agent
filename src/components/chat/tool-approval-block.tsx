"use client";

import { ShieldCheck, ShieldX } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PendingToolCall } from "@/lib/types";

interface ToolApprovalBlockProps {
  toolCalls: PendingToolCall[];
  onApprove: () => void;
  onReject: () => void;
  disabled?: boolean;
}

export function ToolApprovalBlock({
  toolCalls,
  onApprove,
  onReject,
  disabled,
}: ToolApprovalBlockProps) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium text-amber-800">
        <ShieldCheck className="size-4" />
        <span>도구 실행 승인 요청</span>
      </div>

      <div className="space-y-1.5">
        {toolCalls.map((tc) => (
          <div
            key={tc.toolUseId}
            className="flex items-center gap-2 text-xs font-mono text-amber-700 bg-amber-100/50 rounded px-2 py-1.5"
          >
            <span className="font-semibold">{tc.name}</span>
            <span className="text-amber-600/70 truncate">
              ({Object.values(tc.args).map(String).join(", ")})
            </span>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={onApprove}
          disabled={disabled}
          className="bg-emerald-600 hover:bg-emerald-700 text-white h-7 text-xs px-3"
        >
          <ShieldCheck className="size-3 mr-1" />
          승인
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
