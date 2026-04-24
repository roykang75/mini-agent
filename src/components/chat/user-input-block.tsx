"use client";

import { useState } from "react";
import { HelpCircle, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AskUserOption, UserInputAnswer } from "@/lib/types";

interface UserInputBlockProps {
  kind: "choose" | "confirm";
  question: string;
  options?: AskUserOption[];
  multi?: boolean;
  onAnswer: (answer: UserInputAnswer) => void;
  disabled?: boolean;
}

export function UserInputBlock({
  kind,
  question,
  options,
  multi,
  onAnswer,
  disabled,
}: UserInputBlockProps) {
  const [selectedSingle, setSelectedSingle] = useState<string | null>(null);
  const [selectedMulti, setSelectedMulti] = useState<Set<string>>(new Set());

  const handleChooseSubmit = () => {
    if (multi) {
      if (selectedMulti.size === 0) return;
      onAnswer({ kind: "choose", selected: Array.from(selectedMulti) });
    } else {
      if (!selectedSingle) return;
      onAnswer({ kind: "choose", selected: selectedSingle });
    }
  };

  const handleConfirm = (confirmed: boolean) => {
    onAnswer({ kind: "confirm", confirmed });
  };

  const handleCancel = () => {
    onAnswer({ kind: "cancel" });
  };

  const chooseSubmitDisabled =
    disabled || (multi ? selectedMulti.size === 0 : !selectedSingle);

  return (
    <div className="rounded-lg border border-sky-200 bg-sky-50/50 p-3 space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium text-sky-800">
        <HelpCircle className="size-4" />
        <span>사용자 입력 요청</span>
      </div>

      <p className="text-sm text-sky-900 whitespace-pre-wrap leading-relaxed">
        {question}
      </p>

      {kind === "choose" && options && options.length > 0 && (
        <div className="space-y-1.5">
          {options.map((opt) => {
            const checked = multi
              ? selectedMulti.has(opt.id)
              : selectedSingle === opt.id;
            return (
              <label
                key={opt.id}
                className={`flex items-start gap-2 rounded px-2 py-1.5 transition-colors ${
                  checked ? "bg-sky-100" : "bg-sky-100/40 hover:bg-sky-100/70"
                } ${disabled ? "opacity-60 cursor-not-allowed" : "cursor-pointer"}`}
              >
                <input
                  type={multi ? "checkbox" : "radio"}
                  name={multi ? undefined : "user-input-choose"}
                  checked={checked}
                  disabled={disabled}
                  onChange={() => {
                    if (disabled) return;
                    if (multi) {
                      setSelectedMulti((prev) => {
                        const next = new Set(prev);
                        if (next.has(opt.id)) next.delete(opt.id);
                        else next.add(opt.id);
                        return next;
                      });
                    } else {
                      setSelectedSingle(opt.id);
                    }
                  }}
                  className="mt-1 shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium text-sky-900">
                    {opt.label}
                  </div>
                  {opt.description && (
                    <div className="text-xs text-sky-700/80 mt-0.5">
                      {opt.description}
                    </div>
                  )}
                  <div className="text-[10px] font-mono text-sky-600/70 mt-0.5">
                    id: {opt.id}
                  </div>
                </div>
              </label>
            );
          })}
        </div>
      )}

      <div className="flex items-center gap-2">
        {kind === "choose" && (
          <Button
            size="sm"
            onClick={handleChooseSubmit}
            disabled={chooseSubmitDisabled}
            className="bg-sky-600 hover:bg-sky-700 text-white h-7 text-xs px-3"
          >
            <Check className="size-3 mr-1" />
            전송
          </Button>
        )}
        {kind === "confirm" && (
          <>
            <Button
              size="sm"
              onClick={() => handleConfirm(true)}
              disabled={disabled}
              className="bg-sky-600 hover:bg-sky-700 text-white h-7 text-xs px-3"
            >
              <Check className="size-3 mr-1" />
              예
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleConfirm(false)}
              disabled={disabled}
              className="border-slate-300 text-slate-600 hover:bg-slate-50 h-7 text-xs px-3"
            >
              <X className="size-3 mr-1" />
              아니오
            </Button>
          </>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={handleCancel}
          disabled={disabled}
          className="text-slate-500 hover:text-slate-700 hover:bg-slate-100 h-7 text-xs px-3 ml-auto"
        >
          취소
        </Button>
      </div>
    </div>
  );
}
