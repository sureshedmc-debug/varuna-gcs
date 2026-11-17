# Requirements Document

## Introduction

The VARUNA boat backend (`boat-pi/`) runs on the operator's laptop at 127.0.0.1:8001 and commands an ArduRover Pixhawk over MAVLink through the Boat_Phone's USB OTG to TCP 5760 bridge. This feature adds a minimal automatic behavior: when plastic is detected in the boat's camera feed, the motor runs at a fixed power level (default 50%) so the boat moves forward toward the plastic.

The feature performs no navigation, no steering correction, no homing, and no mission execution. The only effect is forward throttle at a set level while detections are fresh. It is designed to be testable on a laptop with no Pixhawk via the `--sim` simulator.

## Glossary

- **Boat_Backend**: The VARUNA boat FastAPI service running on the operator's laptop (`main.py` and its modules), connected to the Pixhawk over the Boat_Phone's TCP 5760 bridge.
- **Boat_Phone**: An Android phone (vivo Y11 5G) running the "VARUNA Boat Link" APK on the boat. It talks to the Pixhawk over USB OTG (its own CDC-ACM driver) and exposes MAVLink on TCP port 5760 for the laptop backend to connect to. It also serves the boat camera as MJPEG on :8080/video and sends the phone's GPS to the Pixhawk as GPS_INPUT.
- **Pixhawk**: The flight controller board running ArduRover firmware on the boat.
- **ArduRover**: The autopilot firmware running on the Pixhawk, configured for a boat frame.
- **MAVLink**: The protocol used between the laptop backend and the Pixhawk (carried over the Boat_Phone's USB OTG to TCP 5760 bridge).
- **RC_override**: A MAVLink message (`RC_CHANNELS_OVERRIDE`) that injects stick values into the Pixhawk, overriding the radio receiver. For this boat: throttle on channel 3 (RCMAP_THROTTLE 3), steering/rudder on channel 4 (RCMAP_ROLL 4). A channel value of 0 in the override means "do not override / use the receiver".
- **rc_source**: A boat config setting, either "transmitter" (an RC transmitter like the FS-i6 is connected to the Pixhawk) or "gamepad" (no transmitter; a game controller on the PC drives via the app).
- **RC_Transmitter**: A handheld radio transmitter (the operator's FlySky FS-i6) whose receiver plugs into the Pixhawk's RC input and provides steering/rudder (channel 4) and throttle (channel 3) directly. When `rc_source` is "transmitter" in config, the laptop's `drive.py` sends NO stick overrides — the transmitter has the boat.
- **Throttle_us**: The throttle PWM signal value in microseconds; for this boat's forward-only BLDC ESC (MAIN OUT 3), 1000 µs is stopped/neutral, 2000 µs is full forward; there is no reverse; the forward span is 1000 µs.
- **Forward_Only_ESC**: The boat's main motor ESC (MAIN OUT 3, SERVO3_FUNCTION 70) is forward-only: 1000 µs = stopped, 2000 µs = full forward, no reverse. 50% power corresponds to 1500 µs.
- **Auto_Throttle**: The new feature described here that commands the motor to a set power level via RC_override when plastic is detected.
- **Implementation_Constraint**: The core boat-pi/*.py files (main.py, live_collect.py, vision.py, config.py, mav_link.py) are read-only and must not be edited. New behavior is added by runtime class patching in `boat-pi/boat_extras.py`, and new config keys are added to `boat_config.json`.
- **Plastic_Detection**: A record POSTed by the VARUNA app to `/api/vision/observe` reporting one or more plastic items seen in the boat's camera frame.
- **Freshness_Window**: The number of seconds after the most recent Plastic_Detection during which the Auto_Throttle stays active.
- **Power_pct**: The configured Auto_Throttle power level as a percentage of the full forward throttle span (0 to 100), where 50 corresponds to 1500 µs.
- **Homing**: The existing camera-guided last-metre approach onto a plastic item (`vision.py`); out of scope for this feature.
- **Live_Collect**: The existing drone-to-boat workflow that navigates the boat to targets the drone spotted (`live_collect.py`); out of scope for this feature.
- **SITL**: Software In The Loop — the built-in simulated Pixhawk (`sim_vehicle.py`) that runs the backend on a laptop with no hardware via `--sim`.

## Requirements

### Requirement 1: Activate on Plastic Detection

**User Story:** As an operator, I want the motor to run automatically when plastic is detected, so that the boat moves toward the plastic without me driving.

#### Acceptance Criteria

1. WHEN a Plastic_Detection containing at least one target arrives at `POST /api/vision/observe`, THE Auto_Throttle SHALL command the motor throttle to the level set by Power_pct, where Power_pct is a percentage in the range 0 to 100.
2. WHILE the most recent Plastic_Detection is within the Freshness_Window, THE Auto_Throttle SHALL hold the motor throttle at the Power_pct level.
3. WHERE auto_throttle_enabled is true, THE Auto_Throttle SHALL activate according to these requirements; WHERE auto_throttle_enabled is false, THE Auto_Throttle SHALL remain inactive and command neutral throttle at zero percent motor power.
4. IF there is no Plastic_Detection within the Freshness_Window, THEN THE Auto_Throttle SHALL command neutral throttle at zero percent motor power.

### Requirement 2: Configurable Power Level

**User Story:** As an operator, I want to set how hard the motor runs, so that I can tune the boat's forward speed.

#### Acceptance Criteria

1. THE Auto_Throttle SHALL command throttle at PWM 1000 plus Power_pct percent of the 1000 µs forward span.
2. WHEN `auto_throttle_power_pct` is set to 50, THE Auto_Throttle SHALL command throttle at PWM 1500 µs.
3. THE Boat_Backend SHALL provide Power_pct as a live setting named `auto_throttle_power_pct` accepting integer values from 0 to 100 in steps of 1 with a default of 50, where changes to the setting take effect without requiring a system restart.
4. IF a value outside the range of 0 to 100 is submitted for `auto_throttle_power_pct`, THEN THE Boat_Backend SHALL reject the submission, indicate an error that the value is out of range, and leave the current Power_pct value unchanged.

### Requirement 3: Neutral Steering

**User Story:** As an operator using an FS-i6 transmitter, I want auto-throttle to handle only forward power, so that I can keep steering the boat myself.

#### Acceptance Criteria

1. THE Auto_Throttle SHALL override only the throttle channel (channel 3) via RC_override and SHALL NOT override the steering channel (channel 4).
2. WHILE the Auto_Throttle is active, THE steering channel SHALL be left to the RC_Transmitter when `rc_source` is "transmitter", or SHALL remain at its current value when `rc_source` is "gamepad".
3. THE Auto_Throttle SHALL not issue any steering correction based on where a detected item appears in the camera frame.

### Requirement 4: Stop When Detections Go Stale

**User Story:** As an operator, I want the motor to stop when no plastic has been seen recently, so that the boat does not run open-ended.

#### Acceptance Criteria

1. WHEN the elapsed time since the most recent Plastic_Detection exceeds the Freshness_Window, THE Auto_Throttle SHALL command and maintain neutral throttle PWM 1000 µs until a subsequent Plastic_Detection arrives.
2. THE Boat_Backend SHALL define the Freshness_Window as the setting `auto_throttle_fresh_s` seconds, with a default of 3.0 and a range of 0.5 to 30.
3. IF `auto_throttle_fresh_s` is set to a value outside the range of 0.5 to 30 seconds, THEN THE Boat_Backend SHALL reject the setting and retain the previously configured valid value.

### Requirement 5: Arming Prerequisite

**User Story:** As an operator, I want auto-throttle to act only when the boat is armed, so that the motor never runs unexpectedly.

#### Acceptance Criteria

1. WHILE the boat is disarmed, THE Auto_Throttle SHALL command Power_pct of 0 (neutral throttle PWM 1000 µs).
2. WHILE the boat is armed, WHEN a Plastic_Detection is within the Freshness_Window, THE Auto_Throttle SHALL command the Power_pct level.
3. WHILE the boat is armed and no Plastic_Detection is within the Freshness_Window, THE Auto_Throttle SHALL command Power_pct of 0 (neutral throttle PWM 1000 µs).

### Requirement 6: Operator and Safety Override

**User Story:** As an operator, I want my commands and safety actions to always win over auto-throttle, so that I retain full control.

#### Acceptance Criteria

1. WHEN the operator issues any Boat_Backend mavlink command (arm, mode, hold, RTL, stop, brake), THE Auto_Throttle SHALL cease autonomous throttle control by commanding neutral throttle (PWM 1000 µs, zero propulsion output) within one decision tick (200 ms).
2. WHEN an Emergency Stop is issued, THE Auto_Throttle SHALL cease autonomous throttle control by commanding neutral throttle (PWM 1000 µs, zero propulsion output) within one decision tick (200 ms).
3. WHILE the flight mode is HOLD, RTL, LOITER, or MANUAL, THE Auto_Throttle SHALL command neutral throttle (PWM 1000 µs).
4. WHEN the boat disarms, THE Auto_Throttle SHALL command neutral throttle (PWM 1000 µs) within one decision tick (200 ms).
5. WHILE the wildlife guard is paused for an animal, THE Auto_Throttle SHALL command neutral throttle (PWM 1000 µs).
6. WHILE the HOLD and disarm sequence executes following an Emergency Stop, THE Auto_Throttle SHALL not issue autonomous throttle commands.

### Requirement 7: Continuous RC Override

**User Story:** As a developer, I want auto-throttle to keep sending its command, so that the Pixhawk does not drop the override and revert to the Pixhawk radio failsafe.

#### Acceptance Criteria

1. WHILE the Auto_Throttle is active and the boat is armed, THE Auto_Throttle SHALL send RC_override at least 10 times per second.
2. WHILE the Auto_Throttle is active and the boat is armed, THE Auto_Throttle SHALL send RC_override with throttle on channel 3 set to the current throttle command value, and every other channel of the RC_override message (including channel 4, the steering channel) set to 0 (release to the FS-i6 receiver).

### Requirement 8: Flight Mode Constraint

**User Story:** As an operator, I want to know that auto-throttle drives the motor directly, so that I understand when the motor moves the boat.

#### Acceptance Criteria

1. THE Auto_Throttle SHALL command the motor exclusively through RC_override.
2. THE Auto_Throttle SHALL leave the boat's flight mode unchanged.
3. IF the boat is in a flight mode other than MANUAL or ACRO, THEN the motor SHALL not move in response to Auto_Throttle RC_override commands.
4. THE operator SHALL place the boat in MANUAL or ACRO mode using the FS-i6 SwD switch (CH8, MODE_CH 8) before auto-throttle can drive the motor.

### Requirement 9: Throttle Channel Ownership

**User Story:** As an operator, I want auto-throttle to own the throttle channel only when nobody is manually driving, so that manual control always has priority.

#### Acceptance Criteria

1. WHEN `rc_source` is "gamepad" and the operator applies throttle through the gamepad with a magnitude greater than 0.05 of full-scale deflection, THE Auto_Throttle SHALL cease commanding the throttle channel, allowing the gamepad throttle value to command the channel.
2. WHEN `rc_source` is "gamepad" and no gamepad client is connected, or the gamepad throttle magnitude is less than or equal to 0.05 of full-scale deflection, THE Auto_Throttle SHALL command the throttle channel.
3. WHEN `rc_source` is "transmitter", THE Auto_Throttle SHALL override the throttle channel (channel 3) with the Power_pct level while active; the operator stops auto-throttle via a Boat_Backend mavlink command (Hold, RTL, stop, or disarm) from the app, not via the FS-i6's throttle stick (CH3), because RC_override takes precedence over the receiver while it is being sent.

### Requirement 10: Suspend Other Automation

**User Story:** As an operator, I want auto-throttle to be the only automatic motion when enabled, so that the boat does not navigate on its own.

#### Acceptance Criteria

1. WHILE the Auto_Throttle is active, THE Boat_Backend SHALL suspend camera Homing and Live_Collect navigation by halting any in-progress Homing and Live_Collect navigation and not initiating new Homing or Live_Collect navigation.
2. WHILE the Auto_Throttle is active, THE Boat_Backend SHALL drive the throttle channel using Auto_Throttle commands and ignore throttle commands from Homing and planned missions.

### Requirement 11: Enable, Disable, and Status

**User Story:** As an operator, I want to turn auto-throttle on or off and read its status, so that I can control the feature.

#### Acceptance Criteria

1. THE Boat_Backend SHALL expose an API endpoint to set `auto_throttle_enabled` to either `true` or `false` and, when read, return the current `auto_throttle_enabled` value.
2. THE Boat_Backend SHALL include Auto_Throttle state in the telemetry payload, comprising `enabled` (boolean), `active` (boolean), `power_pct` (numeric from 0.0 to 100.0), and `last_detection_time_s` (numeric Unix epoch timestamp in seconds).
3. WHEN `auto_throttle_enabled` is changed through the API, THE Boat_Backend SHALL persist the change to `boat_config.json` before returning a success response.
4. IF the API receives a value for `auto_throttle_enabled` that is not `true` or `false`, THEN THE Boat_Backend SHALL reject the request with an error indicating the value is invalid and SHALL leave the current `auto_throttle_enabled` state unchanged.
5. IF persisting the change to `boat_config.json` fails, THEN THE Boat_Backend SHALL return an error indicating the persistence failure, SHALL retain the previous `auto_throttle_enabled` state, and SHALL not return a success response.

### Requirement 12: Optional Secondary Trigger

**User Story:** As an operator, I want live-collect target arrivals to optionally trigger auto-throttle, so that the feature can be used in live-collect mode.

#### Acceptance Criteria

1. WHERE `auto_throttle_on_live_target` is true, WHEN a live-collect target arrives at `POST /api/live/targets`, THE Auto_Throttle SHALL command the Power_pct level for the duration of the Freshness_Window.
2. WHERE `auto_throttle_on_live_target` is false, THE Auto_Throttle SHALL ignore live-collect target arrivals at `POST /api/live/targets`.
3. THE Auto_Throttle SHALL ignore mission start and waypoint reach events.
4. WHEN `auto_throttle_on_live_target` is not explicitly configured, THE Auto_Throttle SHALL treat `auto_throttle_on_live_target` as false.

### Requirement 13: Simulator Support

**User Story:** As a developer, I want to test auto-throttle without a Pixhawk, so that I can verify the feature on a laptop.

#### Acceptance Criteria

1. WHILE the Boat_Backend runs in `--sim` mode, THE Auto_Throttle SHALL send RC_override commands to the SITL periodically at a rate of at least 1 command per second.
2. WHEN a Plastic_Detection arrives in `--sim` mode, THE Auto_Throttle SHALL command the Power_pct throttle to the SITL.
3. WHEN the Auto_Throttle commands the Power_pct throttle to the SITL in `--sim` mode, THE SITL boat SHALL exhibit a forward velocity greater than zero.
4. WHILE the Boat_Backend runs in `--sim` mode, IF the SITL is not available, THEN THE Auto_Throttle SHALL indicate an error that the SITL is unavailable.

## Non-Goals

- Navigation, homing onto items, and path following are out of scope.
- Steering or heading correction is out of scope.
- Automatic arming is out of scope; the operator arms manually.
- Automatic flight-mode changes are out of scope.
- Replacing or rewriting the existing Homing, Live_Collect, mission, wildlife, or water-measurement code is out of scope; this feature only suspends Homing and Live_Collect while active.
- Frontend or app changes are out of scope.
- New camera or AI features are out of scope; the feature consumes existing Plastic_Detection records from `/api/vision/observe`.
- Reverse motor operation is out of scope; the ESC is forward-only (1000 µs = stopped, 2000 µs = full forward).
