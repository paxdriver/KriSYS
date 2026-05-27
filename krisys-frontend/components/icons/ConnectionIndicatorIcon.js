// krisys-frontend/components/icons/ConnectionIndicatorIcon.js
import React from 'react'
/*	
	ConnectionIndicatorIcon
	-----------------------

	Purpose:
	- Presentational-only SVG icon for connection state
	- Does NOT read context
	- Does NOT manage clicks
	- Receives a simple state string and renders the correct colors/styles

	Supported visual states:
	- 'idle'
	- 'connected'
	- 'hosting_idle'
	- 'hosting_active'
	- 'disabled'

	Design notes:
	- We keep the icon layered so its boundaries stay readable:
		- outer rim
		- body
		- top highlight
		- lower shading
		- white glyph
	- Disabled mode is dimmed via opacity rather than special recoloring
	- A slash overlay is shown only in disabled mode


	Centralized visual presets (why keep this map inside the icon?):
	-------------------------- 
	- Makes consuming code simpler
	- Keeps the fixed color system readable
	- Lets parent code pass only `state="connected"` rather than many colors
*/
const STATE_STYLES = {
	idle: {
		rimColor: '#4b5563', 						// Dark neutral grey rim
		bodyColor: '#6b7280', 						// Neutral grey body for "enabled but idle"
		highlightColor: 'rgba(255,255,255,0.18)',  // Soft top highlight for depth
		glyphColor: '#f3f4f6',						// Light inner glyph for contrast
		slashColor: null, 							 // No slash in idle state
		opacity: 1, 								 // Fully visible
	},
	connected: {
		rimColor: '#166534', 				// Dark green rim
		bodyColor: '#22c55e', 				// Green body meaning at least one active connection
		highlightColor: 'rgba(255,255,255,0.20)', // Keep highlight subtle
		glyphColor: '#f8fafc', 			// Bright light glyph
		slashColor: null, 					 // No slash
		opacity: 1, 						 // Fully visible
	},
	hosting_idle: {
		rimColor: '#991b1b', 						// Dark red rim for hosting priority state
		bodyColor: '#dc2626', 						// Red body
		highlightColor: 'rgba(255,255,255,0.10)',  // Lower highlight to keep red more serious
		glyphColor: '#fff7f7', 					// Slightly warm white
		slashColor: null, 							 // No slash
		opacity: 1, 								 // Fully visible
	},
	hosting_active: {
		rimColor: '#7f1d1d', 						// Even darker red rim
		bodyColor: '#ef4444', 						// Stronger red for active hosted-room state
		highlightColor: 'rgba(255,255,255,0.16)',  // Slight highlight for depth
		glyphColor: '#ffffff', 					// Crisp white glyph.
		slashColor: null, 							 // No slash
		opacity: 1, 								 // Fully visible
	},
	disabled: {
		rimColor: '#374151', 						// Dark muted grey rim
		bodyColor: '#6b7280', 						// Same family as idle, but dimmed overall
		highlightColor: 'rgba(255,255,255,0.12)',  // Small highlight, still visible
		glyphColor: '#f3f4f6', 					// Keep glyph readable
		slashColor: '#111827', 					// Dark slash overlay
		opacity: 0.45, 								 // Main disabled treatment: dim whole icon
	},
}

// Small helper to safely resolve state. If an unknown state is passed, we fall back to 'idle' so the UI never breaks on a typo or missing value.
function getVisualStyle(state) {
	if (typeof state !== 'string') {
		return STATE_STYLES.idle
	}

	return STATE_STYLES[state] || STATE_STYLES.idle
}

export default function ConnectionIndicatorIcon({
	state = 'idle', 				// Simple state-based API used by the future smart wrapper
	size = 28, 						// Rendered width/height in pixels
	className = '', 				// Optional CSS hook
	style = {}, 					// Optional extra inline styles from parent
	title = 'Connection status', 	// Accessible label for screen readers/tooltips
}) {
	// Resolve the fixed visual preset for the requested state
	const {
		rimColor,
		bodyColor,
		highlightColor,
		glyphColor,
		slashColor,
		opacity,
	} = getVisualStyle(state)

	// Only disabled mode shows the slash overlay
	const showSlash = state === 'disabled'

	return (
		<svg
			width={size} 			// Set visible width
			height={size} 			// Set visible height
			viewBox='0 0 64 64' 	// Internal coordinate system for scalable drawing
			xmlns='http://www.w3.org/2000/svg' // Standard SVG namespace
			role='img' 				// Accessibility: image semantics
			aria-label={title} 		// Accessibility label
			className={className} 	// Optional external styling
			style={{
				opacity, 			// Dim whole icon in disabled state
				display: 'block', 	// Avoid inline SVG baseline layout quirks
				...style, 			// Allow parent overrides/additions
			}}
		>
			<title>{title}</title>

			{/*	Outer rim: Preserves the strong circular boundary across color changes */}
			<circle
				cx='32'
				cy='32'
				r='30'
				fill={rimColor}
			/>

			{/* Main body:- Main colored fill inside the rim */}
			<circle
				cx='32'
				cy='32'
				r='27'
				fill={bodyColor}
			/>

			{/* Top highlight: Replaces complicated gradients with a simple translucent layer and keeps the icon from looking flat */}
			<ellipse
				cx='32'
				cy='21'
				rx='20'
				ry='11'
				fill={highlightColor}
			/>

			{/* Lower shading: Subtle darker ellipse near the bottom for depth. Uses black with low opacity so it works with all body colors */}
			<ellipse
				cx='32'
				cy='45'
				rx='21'
				ry='10'
				fill='#000000'
				opacity='0.14'
			/>

			{/* Inner network glyph: Light-colored simplified network/device symbol. This remains constant across states for recognizability*/}
			<g fill={glyphColor}>
				{/* Top device block */}
				<rect
					x='22'
					y='16'
					width='20'
					height='10'
					rx='2.5'
				/>

				{/* Top device detail lines */}
				<rect
					x='24'
					y='27.5'
					width='16'
					height='1.8'
					rx='0.9'
				/>
				<rect
					x='24'
					y='30'
					width='16'
					height='1.8'
					rx='0.9'
				/>

				{/* Center vertical connector */}
				<rect
					x='30.5'
					y='32'
					width='3'
					height='9'
					rx='1'
				/>

				{/* Horizontal bus line connecting lower nodes */}
				<rect
					x='17'
					y='41'
					width='30'
					height='3'
					rx='1.2'
				/>

				{/* Left branch down to lower-left node */}
				<rect
					x='19'
					y='41'
					width='3'
					height='7'
					rx='1'
				/>

				{/* Right branch down to lower-right node */}
				<rect
					x='42'
					y='41'
					width='3'
					height='7'
					rx='1'
				/>

				{/* Bottom left node */}
				<rect
					x='12'
					y='48'
					width='13'
					height='8'
					rx='3'
				/>

				{/* Bottom center node */}
				<rect
					x='25.5'
					y='48'
					width='13'
					height='8'
					rx='3'
				/>

				{/* Bottom right node */}
				<rect
					x='39'
					y='48'
					width='13'
					height='8'
					rx='3'
				/>
			</g>

			{/* Disabled slash: Drawn only when state === 'disabled'. Lets grey remain the "idle but available" color family. */}
			{showSlash ? (
				<line
					x1='14'
					y1='50'
					x2='50'
					y2='14'
					stroke={slashColor}
					strokeWidth='4'
					strokeLinecap='round'
				/>
			) : null}
		</svg>
	)
}