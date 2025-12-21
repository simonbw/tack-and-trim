import React, { ReactNode } from "react";

export const CollapsibleCard: React.FC<{
  summary: ReactNode;
  onRemove?: () => void;
  children?: ReactNode;
}> = ({ summary, onRemove, children }) => {
  return (
    <article>
      <details style={{ margin: 0 }} open>
        <summary style={{ position: "relative" }}>
          {summary}
          {onRemove && (
            <button
              className="secondary"
              style={{ position: "absolute", right: "2rem" }}
              onClick={() => onRemove()}
            >
              Remove
            </button>
          )}
        </summary>
        {children}
      </details>
    </article>
  );
};
