import { useEffect, useState } from "react";

/**
 * Runs an async loader and tracks its state. Results from outdated calls
 * (e.g. the user typed again before the previous search finished) are ignored.
 *
 * @template T
 * @param {() => Promise<T>} load  Must be stable for the given `deps`.
 * @param {unknown[]} deps
 * @returns {{ status: "loading" | "success" | "error", data: T | undefined, error: Error | undefined }}
 */
export default function useAsync(load, deps) {
  const [state, setState] = useState({ status: "loading", data: undefined, error: undefined });

  useEffect(() => {
    let isCurrent = true;
    setState((previous) =>
      previous.status === "loading" ? previous : { status: "loading", data: previous.data, error: undefined },
    );

    Promise.resolve()
      .then(load)
      .then(
        (data) => {
          if (isCurrent) setState({ status: "success", data, error: undefined });
        },
        (error) => {
          if (isCurrent) {
            setState({
              status: "error",
              data: undefined,
              error: error instanceof Error ? error : new Error(String(error)),
            });
          }
        },
      );

    return () => {
      isCurrent = false;
    };
    // `load` is intentionally excluded: callers pass an inline function and
    // control re-runs through `deps`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}
