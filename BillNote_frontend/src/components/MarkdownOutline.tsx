import React, { useMemo, useState } from 'react';
import { ChevronRight, ChevronLeft, List } from 'lucide-react';
import { cn } from '@/lib/utils';

interface OutlineItem {
  id: string;
  level: number;
  text: string;
}

interface MarkdownOutlineProps {
  markdown: string;
}

export const MarkdownOutline: React.FC<MarkdownOutlineProps> = ({ markdown }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const outline = useMemo(() => {
    const lines = markdown.split('\n');
    const items: OutlineItem[] = [];
    let inCodeBlock = false;

    lines.forEach((line, index) => {
      // Ignore headers inside code blocks
      if (line.startsWith('```')) {
        inCodeBlock = !inCodeBlock;
      }
      if (inCodeBlock) return;

      const match = line.match(/^(#{1,6})\s+(.*)/);
      if (match) {
        const level = match[1].length;
        let text = match[2].trim();
        // Remove bold/italic markers etc. for a cleaner outline
        text = text.replace(/[*_~`]/g, '');

        // Generate ID matching the ReactMarkdown renderer
        const id = text
          .toLowerCase()
          .replace(/\s+/g, '-')
          .replace(/[^\p{L}\p{N}\-_]/gu, '');

        items.push({ id, level, text });
      }
    });
    return items;
  }, [markdown]);

  if (outline.length === 0) return null;

  return (
    <div
      className={cn(
        "fixed right-0 top-1/4 z-50 flex h-3/4 max-h-[600px] transition-all duration-300 ease-in-out",
        isExpanded ? "translate-x-0" : "translate-x-[calc(100%-2rem)]"
      )}
      onMouseEnter={() => setIsExpanded(true)}
      onMouseLeave={() => setIsExpanded(false)}
    >
      {/* Trigger area when collapsed */}
      <div className="flex h-12 w-8 cursor-pointer items-center justify-center rounded-l-md border border-r-0 border-border bg-background shadow-md">
        {isExpanded ? <ChevronRight size={16} /> : <List size={16} className="text-muted-foreground" />}
      </div>

      {/* Sidebar content */}
      <div className="w-64 overflow-y-auto rounded-l-lg border border-r-0 border-border bg-background/95 p-4 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <h3 className="mb-4 text-sm font-semibold text-foreground">目录大纲</h3>
        <ul className="space-y-2">
          {outline.map((item) => (
            <li
              key={item.id}
              style={{ paddingLeft: `${(item.level - 1) * 0.75}rem` }}
              className="text-sm"
              onClick={() => {
                const element = document.getElementById(item.id);
                if (element) {
                  element.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
              }}
            >
              <span className="text-muted-foreground hover:text-primary line-clamp-2 cursor-pointer transition-colors hover:underline">
                {item.text}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};
