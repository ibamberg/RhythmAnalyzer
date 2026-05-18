export function bindTapInput({ element, onTap, onVisualHit }) {
  const handlePointerDown = (event) => {
    event.preventDefault();
    onTap(performance.now());
    onVisualHit();
  };

  const handleKeyDown = (event) => {
    if (event.code !== "Space") {
      return;
    }
    event.preventDefault();
    onTap(performance.now());
    onVisualHit();
  };

  element.addEventListener("pointerdown", handlePointerDown);
  window.addEventListener("keydown", handleKeyDown);

  return () => {
    element.removeEventListener("pointerdown", handlePointerDown);
    window.removeEventListener("keydown", handleKeyDown);
  };
}
