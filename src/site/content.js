// Words and media for the website. Everything here comes from the project
// itself: the film, the slides and the build. Edit freely.

export const M = (f) => `/site/${f}`

export const NAV = [
  ['Overview', '/#story'],
  ['Achievements', '/#achievements'],
  ['How it works', '/#how'],
  ['Boat 2.0', '/#boat2'],
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
    body: 'Nirmal Dhara Jalyan, a solar-powered autonomous boat, goes to each point by GPS. Its bow ramp scoops the floating waste out of the water and tips it into an on-board bin, steered by an AI captain trained in simulation.',
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
    name: 'Nirmal Dhara Jalyan 2.0',
    role: 'Autonomous air boat',
    img: 'p-boat2-model',
    specs: ['Foam hull with a built-in waste bin', '2 × 2200 KV air motors with twin steering fins', 'Tilting mesh scoop ramp with side brushes', 'ESP32 autopilot + on-board Android phone', 'AI captain, radio override, solar power'],
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
  'ArduCopter', 'ArduRover', 'Pixhawk', 'Raspberry Pi', 'ESP32', 'Android', 'PyTorch', 'Reinforcement learning',
  'Three.js', 'Leaflet', 'face-api',
]

export const COMPARE = [
  ['Waste detection', 'Spotted by eye', 'AI-powered drone'],
  ['Navigation', 'Steered by hand', 'Autonomous boat with an AI captain'],
  ['Waste collection', 'Nets and manual labour', 'Automatic scoop ramp and on-board bin'],
  ['Power source', 'Fuel or muscle', 'Solar-powered'],
  ['Human involvement', 'High', 'Reduced'],
]

export const GALLERY = [
  { type: 'video', src: 'hero-1080', poster: 'hero-1080', title: 'First flight', sub: 'Varuna takes off over the school field', wide: true },
  { type: 'img', src: 'p-boat2-model', title: 'Nirmal Dhara Jalyan 2.0', sub: 'The air boat: scoop ramp, bin and twin fins', wide: true },
  { type: 'img', src: 'p-boat-top', title: 'Nirmal Dhara Jalyan', sub: 'The first boat on its test pool' },
  { type: 'img', src: 'p-detect', title: 'What the drone sees', sub: 'The AI marks a plastic bag' },
  { type: 'video', src: 'boat-raw', poster: 'boat-raw', title: 'Into the water', sub: 'Launching the boat by hand' },
  { type: 'img', src: 'p-school', title: 'Field test', sub: 'Drone, pool and the team at work' },
  { type: 'img', src: 'p-night', title: 'The vision', sub: 'Drone and boat on a night river', wide: true },
  { type: 'video', src: 'detect', poster: 'detect', title: 'Live detection', sub: 'The camera feed in the app' },
  { type: 'img', src: 'p-boat', title: 'Built by hand', sub: 'Electronics inside the EPS hull' },
  { type: 'img', src: 'p-drone-sky', title: 'In the air', sub: 'Hovering above the trees' },
  { type: 'video', src: 'render-night', poster: 'render-night', title: 'Night patrol', sub: 'The app’s 3D river scene' },
  { type: 'video', src: 'boat-scoop', poster: 'boat-scoop', title: 'Plastic, collected', sub: 'The tricolour boat scoops a floating bag' },
  { type: 'img', src: 'award-exhibit', title: 'At the exhibition', sub: 'The VARUNA AI stand, DoE Science Centre No. 4' },
  { type: 'video', src: 'boat-night', poster: 'boat-night', title: 'After dark', sub: 'The boat with its lights on' },
  { type: 'img', src: 'award-trophy', title: 'Position I', sub: 'The 1st-place trophy' },
  { type: 'img', src: 'p-boat2-fleet', title: 'Training ground', sub: 'Virtual ponds where the boat’s AI practises', wide: true },
  { type: 'img', src: 'p-boat2-sim', title: 'Virtual twin', sub: 'The simulated boat tipping its catch into the bin' },
]

// Nirmal Dhara Jalyan 2.0: the air boat and how its AI captain is trained.
export const BOAT2 = {
  stats: [['60 × 40 cm', 'foam hull'], ['1.5 kg', 'all up'], ['1.3 cm', 'in the water'], ['2 × 2200 KV', 'air motors']],
  features: [
    ['Air propulsion', 'Two brushless motors on raised posts push air, not water, so nothing under the hull can catch on weed, rope or plastic.'],
    ['Twin steering fins', 'A fin behind each propeller, each on its own servo, turns the boat precisely, even at a crawl.'],
    ['Scoop ramp and bin', 'A tilting mesh ramp on the bow, with V-wings and side brushes, scoops floating waste and tips it into a bin built into the hull.'],
    ['ESP32 + phone', 'An ESP32 runs the motors, servos and failsafes; an Android phone on board adds GPS, compass, gyro, camera and the link to the app.'],
    ['Solar powered', 'A solar panel on board helps keep the battery charged on the water.'],
    ['Always in safe hands', 'A FlySky radio overrides the autopilot instantly, and the boat stops by itself if the signal is lost.'],
  ],
  pipeline: [
    ['Measure the real boat', 'Every drive is recorded on the boat’s phone 25 times a second: motor and servo commands, GPS, compass and gyro. From these logs the boat’s real thrust, drag and turning are measured.'],
    ['Build a virtual twin', 'A physics simulator of the boat at its true size and weight, with its motors, fins, ramp and bin, on ponds with drifting bottles, weed, banks, wind, gusts and currents.'],
    ['Train thousands at once', '2,048 virtual boats practise side by side with reinforcement learning (PPO). Each one gets slightly different physics and sensor errors, and harder conditions unlock as the AI improves.'],
    ['Deploy to the boat', 'The trained AI captain is a compact neural network that runs on the boat’s phone 20 times a second. The ESP32 keeps every safety limit, and the radio can take over at any moment.'],
  ],
  skills: ['Hold a straight line in wind', 'Steer to each bottle the camera sees', 'Lower the ramp and slow down for a catch', 'Raise the ramp over weed', 'Tip the catch into the bin', 'Search when nothing is in sight', 'Keep clear of the banks', 'Return home when full or low on battery'],
  simStats: [['2,048', 'boats trained at once'], ['20 Hz', 'decisions per second'], ['Domain', 'randomised physics']],
}

// The competition win. Wording follows the certificate and the trophy.
export const AWARD = {
  headline: 'First place at DoE Science Centre No. 4',
  event: 'Centre Level Science & Mathematics Exhibition 2026-27',
  org: 'Directorate of Education, Govt. of NCT of Delhi',
  centre: 'Science Centre No. 4, Gazipur, Delhi',
  category: 'Artificial Intelligence',
  venue: 'CM Shri School, Surajmal Vihar, Delhi',
  next: 'Selected for Skill Expo',
}

// Photos and a clip from the competition (opened big in the viewer).
export const AWARD_MEDIA = [
  { type: 'img', src: 'award-stage-photo', title: '1st place, on stage', sub: 'Receiving the trophy and certificates at Science Centre No. 4' },
  { type: 'img', src: 'award-trophy', title: 'The trophy', sub: 'Position I · Centre Level Science & Mathematics Exhibition 2026-27' },
  { type: 'img', src: 'award-certificate', title: 'The certificate', sub: 'Directorate of Education, Govt. of NCT of Delhi · Science Branch' },
  { type: 'img', src: 'award-exhibit', title: 'The VARUNA AI stand', sub: 'Drone, boat, app and trophies at the exhibition' },
]

// New footage of the tricolour collector boat.
export const BOAT_REELS = [
  { type: 'video', src: 'boat-scoop', poster: 'boat-scoop', tag: 'Collect', title: 'Scooping the plastic', sub: 'The front net lifts a floating bag out of the water' },
  { type: 'video', src: 'boat-drone', poster: 'boat-drone', tag: 'Team-up', title: 'Drone above, boat below', sub: 'Varuna flies over while the boat waits on the water' },
  { type: 'video', src: 'boat-night', poster: 'boat-night', tag: 'Night run', title: 'Lights on, after dark', sub: 'The tricolour hull with its LED strip glowing' },
]
export const MATCH_CLIP = [
  { type: 'video', src: 'app-match', poster: 'app-match', title: 'Waste matched', sub: 'The boat’s camera confirms it is the same plastic the drone found' },
]

export const TEAM = {
  school: 'Bhai Parmanand Vidya Mandir',
  theme: 'Environment & Sustainability',
  makers: [
    { name: 'Aditya Gautam', role: 'Creator of VARUNA AI · drone, boat and ground-control app', initials: 'AG' },
    { name: 'Samar Garg', role: 'Co-creator of VARUNA AI', initials: 'SG' },
  ],
}

// How to reach the team: a call to Aditya Gautam, for any enquiry or funding.
export const CONTACT = {
  name: 'Aditya Gautam',
  phone: '+91 78383 24455',
  tel: '+917838324455',
  whatsapp: `https://wa.me/917838324455?text=${encodeURIComponent('Hi Aditya, I saw VARUNA AI and would like to talk about ')}`,
  topics: ['Enquiries', 'Funding & sponsorship', 'Partnerships', 'Demos & media'],
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
    q: 'Has VARUNA AI won any awards?',
    a: 'Yes. VARUNA AI, by Aditya Gautam and Samar Garg, won first place (Position I) in Artificial Intelligence at the Centre Level Science & Mathematics Exhibition 2026-27 of the Directorate of Education, Govt. of NCT of Delhi, at Science Centre No. 4, Gazipur, held at CM Shri School, Surajmal Vihar. It was then selected for Skill Expo.',
  },
  {
    q: 'How can I contact the VARUNA AI team?',
    a: 'Call or WhatsApp Aditya Gautam, creator of VARUNA AI, directly on +91 78383 24455 for any enquiry, funding or sponsorship, partnership or demo.',
  },
  {
    q: 'What is VARUNA AI?',
    a: 'VARUNA AI is a river-cleaning system made of two machines: Varuna, an AI drone that flies over a river and finds floating plastic, and Nirmal Dhara Jalyan, a solar-powered autonomous boat that goes to that plastic and collects it. The current boat, Nirmal Dhara Jalyan 2.0, is an air boat with a scoop ramp, an on-board bin and an AI captain.',
  },
  {
    q: 'What is Nirmal Dhara Jalyan 2.0?',
    a: 'Nirmal Dhara Jalyan 2.0 is the second-generation VARUNA AI collector boat: a 60 by 40 cm, 1.5 kg foam hull driven by two 2200 KV air motors with a steering fin behind each. A tilting mesh ramp on the bow scoops floating waste and tips it into a bin built into the hull. An ESP32 controls the motors and servos, an Android phone on board provides GPS, compass and camera, solar power helps charge the battery, and a FlySky radio can take over at any time.',
  },
  {
    q: 'How is the boat’s AI trained?',
    a: 'The boat’s AI captain is trained in simulation with reinforcement learning. A physics model of the real boat runs 2,048 virtual boats at once, each with slightly different physics, weather and sensor errors, so the AI learns to steer to plastic, scoop it, tip it into the bin, avoid weed and banks and return home. Logs recorded on the real boat are used to match the simulator to reality before the AI runs on the boat’s phone.',
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
    a: 'Yes. The Try the AI page at varuna-gcs.vercel.app/try runs the same plastic detection on your own webcam, inside your browser. The VARUNA GCS app is free to download for Android and Windows once you sign in with a Google account.',
  },
]
