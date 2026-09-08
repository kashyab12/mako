import { useId } from "react"

/** Coordinates share the engraving's viewBox and bottom-aligned cover crop. */
export function OceanFin() {
  const id = useId()
  return (
    <svg
      className="ocean-fin"
      viewBox="0 0 1536 1024"
      preserveAspectRatio="xMidYMax slice"
      aria-hidden="true"
    >
      <defs>
        <clipPath id={`${id}-outline`}>
          <path d="M1143 709C1159 672 1180 641 1209 627C1203 663 1200 705 1215 723C1190 720 1165 716 1143 712Z" />
        </clipPath>
        <pattern
          id={`${id}-grain`}
          width="9"
          height="9"
          patternUnits="userSpaceOnUse"
        >
          <g fill="currentColor">
            <circle cx="1.2" cy="1.6" r="1.05" />
            <circle cx="5.8" cy="0.9" r="0.9" />
            <circle cx="3.6" cy="4.4" r="1.15" />
            <circle cx="8.1" cy="5.3" r="1" />
            <circle cx="0.6" cy="7.3" r="0.85" />
            <circle cx="5.3" cy="8.2" r="1.05" />
          </g>
        </pattern>
        <linearGradient id={`${id}-light`} x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0.2" stopColor="currentColor" stopOpacity="0" />
          <stop offset="0.5" stopColor="currentColor" />
          <stop offset="0.8" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
        <mask
          id={`${id}-reveal`}
          className="ocean-fin-mask"
          maskUnits="userSpaceOnUse"
          x="1110"
          y="580"
          width="150"
          height="190"
        >
          <rect
            className="ocean-fin-glint"
            x="1090"
            y="565"
            width="190"
            height="240"
            fill={`url(#${id}-light)`}
          />
        </mask>
      </defs>
      <g clipPath={`url(#${id}-outline)`}>
        <path
          d="M1110 600H1260V750H1110Z"
          fill={`url(#${id}-grain)`}
          mask={`url(#${id}-reveal)`}
        />
      </g>
    </svg>
  )
}
