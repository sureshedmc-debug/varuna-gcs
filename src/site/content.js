// Words and media for the website. Everything here comes from the project
// itself: the film, the slides and the build. Edit freely.

export const M = (f) => `/site/${f}`

export const NAV = [
  ['Overview', '/#story'],
  ['How it works', '/#how'],
  ['Technology', '/#tech'],
  ['Gallery', '/#gallery'],
  ['Team', '/#team'],
  ['Try the AI', '/try'],
  ['Feedback', '/#feedback'],
]

export const STEPS = [
  {
    n: '01',
    kicker: 'Detect',
    title: 'The AI drone spots the plastic',
    body: 'Varuna, a quadcopter with a downward camera, flies over the river. An AI model running live on the video marks every floating bottle and bag it sees, with how sure it is.',
    video: 'detect',
    tag: 'Live drone feed · plastic bag 87%',
  },
  {
    n: '02',
    kicker: 'Locate',
    title: 'The Varuna app pins it on the map',
    body: 'The ground-control app turns each find into a GPS point on the river, plans the route section by section and keeps a record of every mission, detection and coordinate.',
    video: 'render-day',
    tag: 'Ground control · Direct Mission Plan',
  },
  {
    n: '03',
    kicker: 'Collect',
    title: 'The boat drives there and collects it',
    body: 'Nirmal Dhara Jalyan, a solar-powered autonomous boat, follows the points by GPS. Its front ramp and intake roller lift the waste out of the water into its collection net.',
    video: 'boat',
    tag: 'Nirmal Dhara Jalyan · collecting',
  },
]

export const MACHINES = [
  {
    name: 'Varuna',
    role: 'AI aerial scout',
    img: 'p-drone-sky',
    specs: ['Quadcopter frame, 4 BLDC motors', 'Pixhawk flight controller', 'Raspberry Pi 3B+ on board', 'GPS module and camera', 'LiPo battery and propellers'],
  },
  {
    name: 'Nirmal Dhara Jalyan',
    role: 'Autonomous collector boat',
    img: 'p-boat-top',
    specs: ['Thermocol (EPS) floating body', 'Pixhawk 1 and Raspberry Pi Zero', '2 BLDC thrusters with ESCs', 'Intake roller and collection net', 'Front ramp, GPS, USB camera, solar power'],
  },
  {
    name: 'VARUNA GCS',
    role: 'Ground-control app',
    img: 'p-render',
    specs: ['Plan missions on real river maps', 'Live drone video with AI detection', 'Drive and watch the boat', 'Face, fingerprint or Google sign-in', 'Every mission saved as records'],
  },
]

export const STACK = [
  'Python', 'FastAPI', 'React', 'Vite', 'Electron', 'YOLO', 'ONNX Runtime', 'OpenCV', 'pymavlink',
  'ArduCopter', 'ArduRover', 'Pixhawk', 'Raspberry Pi', 'Three.js', 'Leaflet', 'face-api',
]

export const COMPARE = [
  ['Waste detection', 'Spotted by eye', 'AI-powered drone'],
  ['Navigation', 'Steered by hand', 'Autonomous GPS boat'],
  ['Waste collection', 'Nets and manual labour', 'Automated conveyor belt'],
  ['Power source', 'Fuel or muscle', 'Solar-powered'],
  ['Human involvement', 'High', 'Reduced'],
]

export const GALLERY = [
  { type: 'video', src: 'hero-1080', poster: 'hero-1080', title: 'First flight', sub: 'Varuna takes off over the school field', wide: true },
  { type: 'img', src: 'p-boat-top', title: 'Nirmal Dhara Jalyan', sub: 'The boat on its test pool' },
  { type: 'img', src: 'p-detect', title: 'What the drone sees', sub: 'The AI marks a plastic bag' },
  { type: 'video', src: 'boat-raw', poster: 'boat-raw', title: 'Into the water', sub: 'Launching the boat by hand' },
  { type: 'img', src: 'p-school', title: 'Field test', sub: 'Drone, pool and the team at work' },
  { type: 'img', src: 'p-night', title: 'The vision', sub: 'Drone and boat on a night river', wide: true },
  { type: 'video', src: 'detect', poster: 'detect', title: 'Live detection', sub: 'The camera feed in the app' },
  { type: 'img', src: 'p-boat', title: 'Built by hand', sub: 'Electronics inside the EPS hull' },
  { type: 'img', src: 'p-drone-sky', title: 'In the air', sub: 'Hovering above the trees' },
  { type: 'video', src: 'render-night', poster: 'render-night', title: 'Night patrol', sub: 'The app’s 3D river scene' },
]

export const TEAM = {
  school: 'Bhai Parmanand Vidya Mandir',
  theme: 'Environment & Sustainability',
  makers: [
    { name: 'Aditya Gautam', role: 'Creator of VARUNA AI · drone, boat and ground-control app', initials: 'AG' },
    { name: 'Samar Garg', role: 'Co-creator of VARUNA AI', initials: 'SG' },
  ],
}

// Plain questions and answers. Shown on the home page, written into the page's
// search data, and built into the static /about page (vite.config.js), so the
// three always say the same thing. Answers are plain text, no markup.
export const FAQ = [
  {
    q: 'Who created VARUNA AI?',
    a: 'VARUNA AI was created by Aditya Gautam and Samar Garg, students of Bhai Parmanand Vidya Mandir, for the theme Environment & Sustainability. They designed, wired, coded and tested the drone, the boat and the VARUNA GCS ground-control app themselves.',
  },
  {
    q: 'What is VARUNA AI?',
    a: 'VARUNA AI is a river-cleaning system made of two machines: Varuna, an AI drone that flies over a river and finds floating plastic, and Nirmal Dhara Jalyan, a solar-powered autonomous boat that goes to that plastic and collects it.',
  },
  {
    q: 'What is VARUNA GCS?',
    a: 'VARUNA GCS is the ground-control app of VARUNA AI, made by Aditya Gautam and Samar Garg. It plans missions, shows the drone’s live camera with AI plastic detection, and sends the boat to collect what the drone finds. It runs in the browser, on Windows and on Android.',
  },
  {
    q: 'How does VARUNA AI find plastic?',
    a: 'An object-detection model trained on images of litter watches the drone’s camera and draws a box around each piece of plastic it sees, together with its GPS position. The detection runs on the device itself, so the video never has to leave it.',
  },
  {
    q: 'Can I try VARUNA AI?',
    a: 'Yes. The Try the AI page at varuna-gcs.vercel.app/try runs the same plastic detection on your own webcam, inside your browser. The VARUNA GCS app is free to download for Android and Windows.',
  },
]
