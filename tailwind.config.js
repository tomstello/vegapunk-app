/** @type {import('tailwindcss').Config} */

// using mode JIT helps with faster build times
// and smaller css files: https://v2.tailwindcss.com/docs/just-in-time-mode

export default {
	mode: 'jit',
	content: ['./src/**/*.{html,js,svelte,ts}', "./node_modules/svhighlight/**/*.svelte"],
	// Classes that can arrive at RUNTIME via chatParams.appearance (postMessage
	// config from Qualtrics). JIT only emits classes found in source, so any
	// utility a study config may send must be safelisted here.
	safelist: [
		'bg-white', 'bg-transparent', 'bg-black', 'bg-blue-600', 'bg-slate-800', 'bg-slate-300',
		'text-white', 'text-black',
		'opacity-20', 'opacity-40', 'opacity-55', 'opacity-60', 'opacity-80', 'opacity-100',
	],
	theme: {
		extend: {
			maxHeight: {
				'128': '32rem',
				'75vh': '75vh',
			}
		},
		screens: {
			'xs': '450px',
			'sm': '640px',
			// => @media (min-width: 640px) { ... }

			'md': '768px',
			// => @media (min-width: 768px) { ... }

			'lg': '1024px',
			// => @media (min-width: 1024px) { ... }

			'xl': '1280px',
			// => @media (min-width: 1280px) { ... }

			'2xl': '1536px',
			// => @media (min-width: 1536px) { ... }
		}
	},
	plugins: [require('daisyui'), require('@tailwindcss/typography')],
	daisyui: {
		themes: ["light"], // https://daisyui.com/docs/themes/
	},
};
