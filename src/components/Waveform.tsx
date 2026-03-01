import { useEffect, useRef } from "react";

interface WaveformProps {
  audioLevel: number;
  isRecording: boolean;
  onClick?: () => void;
}

export function Waveform({ audioLevel, isRecording, onClick }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRef = useRef<number>(0);
  const prevBarsRef = useRef<number[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    const centerY = height / 2;

    const barCount = 21;
    const barWidth = 4;
    const gap = 3;
    const totalWidth = barCount * (barWidth + gap) - gap;
    const startX = (width - totalWidth) / 2;
    const centerIndex = Math.floor(barCount / 2);

    if (prevBarsRef.current.length !== barCount) {
      prevBarsRef.current = new Array(barCount).fill(2);
    }

    const draw = () => {
      ctx.clearRect(0, 0, width, height);

      const primaryColor = "#e95420";

      const speakingThreshold = 0.01;
      const isSpeaking = isRecording && audioLevel > speakingThreshold;

      for (let i = 0; i < barCount; i++) {
        const distFromCenter = Math.abs(i - centerIndex);
        const maxDist = centerIndex + 1;
        const positionScale = Math.exp(
          -Math.pow(distFromCenter / (maxDist * 0.6), 2)
        );

        let targetHeight: number;

        if (isSpeaking) {
          const time = Date.now() / 150;
          const wave = Math.sin(time + i * 0.2) * 0.3 + 0.7;
          const jitter = Math.random() * 0.1;

          const sensitiveLevel = Math.pow(audioLevel * 2.5, 0.8);

          targetHeight = Math.max(
            4,
            sensitiveLevel * positionScale * wave * height * 0.8 +
              jitter * height * 0.1
          );
        } else {
          const idleTime = Date.now() / 1000;
          const idleWave = Math.sin(idleTime + i * 0.1) * 0.1 + 0.9;
          targetHeight = 3 + positionScale * idleWave * 3;
        }

        const riseSpeed = 0.25;
        const fallSpeed = 0.15;
        const currentHeight = prevBarsRef.current[i];
        const speed = targetHeight > currentHeight ? riseSpeed : fallSpeed;

        const smoothedHeight =
          currentHeight + (targetHeight - currentHeight) * speed;
        prevBarsRef.current[i] = smoothedHeight;

        const x = startX + i * (barWidth + gap);
        const y = centerY - smoothedHeight / 2;

        ctx.fillStyle = isRecording ? primaryColor : "rgba(255, 255, 255, 0.25)";
        ctx.beginPath();
        if (ctx.roundRect) {
          ctx.roundRect(x, y, barWidth, smoothedHeight, 10);
        } else {
          ctx.rect(x, y, barWidth, smoothedHeight);
        }
        ctx.fill();
      }

      animationFrameRef.current = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      cancelAnimationFrame(animationFrameRef.current);
    };
  }, [audioLevel, isRecording]);

  return (
    <div
      className="flex items-center justify-center py-2 cursor-pointer"
      onClick={onClick}
    >
      <canvas ref={canvasRef} width={150} height={48} />
    </div>
  );
}
