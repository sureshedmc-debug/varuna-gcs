# Requirements Document

## Introduction

This document specifies the requirements for integrating face detection into the river cleanup drone system's AI detection pipeline. The system currently uses a trash detection model (`trash.onnx`) that occasionally misidentifies human faces as trash objects. A face detection model (`face-yolo.onnx`) exists but is not currently integrated into the detection workflow.

This feature will activate the face detector to run alongside the trash detector, suppress false-positive trash detections that overlap with detected faces, and display tracked face detections with distinct visual styling (yellow dotted-line bounding boxes labeled "Human").

## Glossary

- **Face_Detector**: The YOLOv11n-face model that identifies human faces in video frames
- **Trash_Detector**: The primary YOLOv11 model that identifies trash and plastic bottles
- **Detection_Pipeline**: The main detection loop in WebcamDetect component that processes frames
- **Box_Tracker**: The tracking system that smooths detection boxes across frames to prevent jitter
- **Overlap_Suppression**: The process of removing trash detections that significantly overlap with face detections
- **Visual_Renderer**: The canvas drawing system that renders bounding boxes on video frames

## Requirements

### Requirement 1: Face Detector Initialization

**User Story:** As a system operator, I want the face detector to load automatically when the detection system starts, so that face suppression is available for every detection session.

#### Acceptance Criteria

1. WHEN the Detection_Pipeline initializes, THE System SHALL load the Face_Detector model from `/models/face-yolo.onnx`
2. WHEN the Face_Detector fails to load, THE System SHALL log the error and continue operation with trash detection only
3. THE Face_Detector SHALL share the ONNX runtime instance with the Trash_Detector to minimize memory usage
4. WHEN both models are loaded, THE System SHALL report both execution providers (WebGPU/WASM) in status messages
5. THE Face_Detector SHALL be disposed when the Detection_Pipeline component unmounts

### Requirement 2: Face Detection Execution

**User Story:** As a system operator, I want face detection to run on every frame alongside trash detection, so that faces are consistently identified for suppression and display.

#### Acceptance Criteria

1. WHEN a new frame arrives in the detection loop, THE System SHALL execute Face_Detector inference before processing trash detections
2. THE Face_Detector SHALL use a confidence threshold of 0.5 for face detection
3. THE Face_Detector SHALL use an IOU threshold of 0.3 for non-maximum suppression
4. WHEN Face_Detector inference fails, THE System SHALL log the error and continue with trash detection only for that frame
5. THE System SHALL complete both face detection and trash detection within the existing frame budget without reducing overall FPS by more than 10%

### Requirement 3: Overlap-Based Suppression

**User Story:** As a system operator, I want trash detections that overlap with faces to be removed, so that humans are not incorrectly labeled as trash.

#### Acceptance Criteria

1. WHEN both face boxes and trash boxes exist for a frame, THE System SHALL calculate overlap ratio for each trash box against all face boxes
2. IF a trash box has an overlap ratio greater than 0.4 with any face box, THEN THE System SHALL remove that trash box from the output
3. THE System SHALL use the existing `overlapRatio()` utility function for overlap calculation
4. THE Overlap_Suppression SHALL occur after trash detection but before box tracking
5. WHERE multiple face boxes overlap the same trash box, THE System SHALL suppress the trash box if it exceeds the threshold with ANY face box

### Requirement 4: Face Box Visual Styling

**User Story:** As a system operator, I want detected faces to appear with distinct visual styling, so that I can easily distinguish humans from trash objects on the display.

#### Acceptance Criteria

1. THE Visual_Renderer SHALL draw face bounding boxes with a yellow stroke color (#FFD60A)
2. THE Visual_Renderer SHALL apply a dashed line pattern [5, 5] to face bounding boxes
3. THE Visual_Renderer SHALL draw face bounding boxes with the same line width as trash boxes
4. THE Visual_Renderer SHALL render a label background for face boxes using the same glassmorphism style as trash boxes
5. WHEN rendering the label text, THE Visual_Renderer SHALL use yellow (#FFD60A) for the glow shadow effect

### Requirement 5: Face Box Labeling

**User Story:** As a system operator, I want detected faces to be labeled as "Human", so that the displayed information clearly identifies people in the frame.

#### Acceptance Criteria

1. THE System SHALL define a new canonical label entry "human" in the CANON labels dictionary
2. THE "human" label entry SHALL map to display text "Human" and color "#FFD60A"
3. WHEN a face box is prepared for tracking, THE System SHALL assign label "Human" and color "#FFD60A"
4. THE System SHALL include "Human" count in the total detection count displayed in the status bar
5. WHEN face boxes are rendered, THE label text SHALL read "Human" without confidence scores

### Requirement 6: Face Box Tracking

**User Story:** As a system operator, I want face boxes to be tracked across frames with temporal smoothing, so that face bounding boxes remain stable and do not jitter between frames.

#### Acceptance Criteria

1. THE System SHALL feed face boxes into the Box_Tracker alongside trash boxes
2. THE Box_Tracker SHALL match face boxes across frames using IOU-based association with threshold 0.3
3. THE Box_Tracker SHALL apply exponential smoothing with weight 0.55 to face box positions
4. THE Box_Tracker SHALL maintain face boxes for 700ms after last detection
5. WHEN tracking both faces and trash, THE Box_Tracker SHALL treat them as separate trackable objects that can coexist

### Requirement 7: Status Reporting

**User Story:** As a system operator, I want to see when face detection is active in the status display, so that I understand which AI models are currently running.

#### Acceptance Criteria

1. WHEN the Face_Detector is successfully loaded, THE System SHALL update the status message to indicate face detection capability
2. WHEN displaying the live detection count, THE System SHALL include face detections in the total count
3. WHEN Face_Detector initialization fails, THE System SHALL display a warning message indicating reduced functionality
4. THE System SHALL continue to display FPS and detection counts as before
5. WHERE the status pill shows "AI LIVE", THE System SHALL include face detection in the active models description

### Requirement 8: Error Handling and Graceful Degradation

**User Story:** As a system operator, I want the system to continue operating if face detection fails, so that trash detection remains functional even when face detection encounters errors.

#### Acceptance Criteria

1. IF Face_Detector fails to initialize, THEN THE System SHALL proceed with trash detection only
2. IF Face_Detector inference throws an error, THEN THE System SHALL skip overlap suppression for that frame and render all trash boxes
3. WHEN Face_Detector errors occur, THE System SHALL log error details to the console
4. THE System SHALL NOT display face-related errors to the user unless they prevent core functionality
5. WHEN Face_Detector is unavailable, THE System SHALL NOT reduce overall system performance or frame rate

### Requirement 9: Performance Requirements

**User Story:** As a system operator, I want face detection to run efficiently without significantly impacting trash detection performance, so that the overall detection system remains responsive.

#### Acceptance Criteria

1. THE Face_Detector SHALL complete inference within 60ms on WebGPU execution provider
2. THE Face_Detector SHALL complete inference within 120ms on WASM execution provider
3. THE combined detection pipeline SHALL maintain at least 90% of the original FPS when face detection is active
4. THE Overlap_Suppression algorithm SHALL complete in less than 5ms for typical frame box counts (up to 50 boxes)
5. THE System SHALL NOT allocate new Box_Tracker instances per frame

### Requirement 10: Integration with Long-Range Scanning

**User Story:** As a system operator, I want face detection to work seamlessly with the existing long-range tiled scanning feature, so that faces are detected and suppressed regardless of scanning mode.

#### Acceptance Criteria

1. WHEN long-range scanning is enabled, THE Face_Detector SHALL run on the full frame, not on individual tiles
2. THE Overlap_Suppression SHALL apply to trash boxes from both full-frame detection and tiled detection passes
3. THE System SHALL display face boxes independently of the tile scan visualization
4. WHEN a tile scan identifies trash that overlaps a face, THE System SHALL suppress that trash box before final rendering
5. THE Face_Detector SHALL NOT increase tile scan processing time by more than 10%

