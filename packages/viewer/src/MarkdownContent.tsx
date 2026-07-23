"use client";

import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  isExternalMarkdownUrl,
  prepareAssistantMarkdown,
  transformMarkdownUrl,
} from "./markdown.ts";

export type MarkdownContentProps = {
  isStreaming: boolean;
  source: string;
};

const MARKDOWN_PLUGINS = [remarkGfm];

const MARKDOWN_COMPONENTS: Components = {
  a({ node: _node, href, children, ...props }) {
    void _node;
    if (!href) return <>{children}</>;

    const isExternal = isExternalMarkdownUrl(href);
    return (
      <a
        {...props}
        href={href}
        rel={isExternal ? "noopener noreferrer" : undefined}
        target={isExternal ? "_blank" : undefined}
      >
        {children}
      </a>
    );
  },
  img({ node: _node, alt }) {
    void _node;
    return (
      <span className="markdown-image-placeholder">
        {alt ? `Image: ${alt}` : "Image"}
      </span>
    );
  },
};

export const MarkdownContent = memo(function MarkdownContent({
  isStreaming,
  source,
}: MarkdownContentProps) {
  const renderedSource = prepareAssistantMarkdown(source, isStreaming);

  return (
    <div className="assistant-text">
      <ReactMarkdown
        components={MARKDOWN_COMPONENTS}
        remarkPlugins={MARKDOWN_PLUGINS}
        skipHtml={true}
        urlTransform={transformMarkdownUrl}
      >
        {renderedSource}
      </ReactMarkdown>
    </div>
  );
});
