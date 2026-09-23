# Implementation Plan: Face Detection Integration

## Overview

This plan implements face detection integration into the existing trash detection pipeline. The implementation adds a face detector model that runs alongside the trash detector to suppress false-positive trash detections on human faces, displaying detected faces with distinct yellow dotted-line styling labeled "Human".

## Tasks

- [x] 1. Extend label dictionary with human label
  - Add "human" entry to CANON dictionary in `src/lib/labels.js`
  - Define label as "Human" with color "#FFD60A"
  - _Requirements: 5.1, 5.2_

- [x] 2. Implement overlap suppression utility function
  - [x] 2.1 Create suppressOverlapping function in WebcamDetect.jsx
    - Accept trashBoxes, faceBoxes, and threshold parameters
    - Use overlapRatio from detector.js to calculate coverage
    - Filter out trash boxes with overlap > threshold
    - Return filtered trash box array
    - _Requirements: 3.1, 3.2, 3.3, 3.5_
  
  - [ ]* 2.2 Write unit tests for suppressOverlapping
    - Test removal of trash box with 50% overlap (above threshold)
    - Test keeping trash box with 30% overlap (below threshold)
    - Test handling of empty face array
    - Test multiple face boxes overlapping same trash box
    - _Requirements: 3.1, 3.2, 3.3, 3.5_

- [x] 3. Initialize face detector in WebcamDetect component
  - [x] 3.1 Add faceDetRef state reference
    - Add useRef for face detector instance
    - _Requirements: 1.1, 1.5_
  
  - [x] 3.2 Load face detector in initialization useEffect
    - Import createFaceDetector from faceDetector.js
    - Call createFaceDetector with progress callback
    - Store result in faceDetRef
    - Update status to reflect dual-model state (e.g., "webgpu+face")
    - Update status message to "Trash + face models ready"
    - _Requirements: 1.1, 1.3, 1.4, 7.1_
  
  - [x] 3.3 Implement graceful degradation for face detector load failure
    - Wrap face detector initialization in try-catch
    - Log warning to console on failure
    - Update status message to indicate face detection disabled
    - Continue with trash-only detection
    - _Requirements: 1.2, 8.1, 8.3, 8.4, 7.3_
  
  - [x] 3.4 Add face detector disposal to cleanup
    - Call faceDetRef.current?.dispose() in useEffect cleanup
    - _Requirements: 1.5_

- [x] 4. Checkpoint - Verify initialization and error handling
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Integrate face detection into detection loop
  - [x] 5.1 Add face detection call before trash detection
    - Call faceDetRef.current.detectFaces with source element
    - Use confThr: 0.5 and iouThr: 0.3
    - Store result in faceBoxes variable
    - _Requirements: 2.1, 2.2, 2.3_
  
  - [x] 5.2 Implement per-frame error handling for face detection
    - Wrap face detection in try-catch
    - Log error to console on failure
    - Set faceBoxes to empty array on error
    - Continue with trash detection
    - _Requirements: 2.4, 8.2, 8.3, 8.4_
  
  - [x] 5.3 Apply overlap suppression after trash detection
    - Call suppressOverlapping with trash boxes, face boxes, and 0.4 threshold
    - Store filtered result in filteredTrash variable
    - _Requirements: 3.1, 3.2, 3.4_
  
  - [x] 5.4 Label face boxes for display
    - Map face boxes to labeled format
    - Assign label "Human", color "#FFD60A", cls "human"
    - _Requirements: 5.3, 5.4_
  
  - [x] 5.5 Combine face and trash boxes for tracking
    - Concatenate labeled face boxes and filtered trash boxes
    - Pass combined array to tracker.update()
    - _Requirements: 6.1, 6.5_

- [x] 6. Update canvas rendering for face box styling
  - [x] 6.1 Add conditional styling based on label type
    - Check if box label is "Human"
    - Apply setLineDash([5, 5]) for face boxes
    - Apply setLineDash([]) for trash boxes
    - Reset dash pattern after strokeRect
    - _Requirements: 4.2, 4.3_
  
  - [x] 6.2 Verify color and glow application
    - Confirm yellow (#FFD60A) stroke color applied to face boxes
    - Confirm yellow shadow color applied to face label text
    - _Requirements: 4.1, 4.5_

- [x] 7. Update status reporting
  - [x] 7.1 Modify status pill to show dual-model info
    - Update engineLabel to include "+face" when face detector active
    - Display combined model count in live status
    - _Requirements: 7.1, 7.2, 7.5_
  
  - [x] 7.2 Include face count in total detection count
    - Verify face boxes included in count state
    - Verify face count appears in status display
    - _Requirements: 5.4, 7.2_

- [x] 8. Checkpoint - Verify integration and rendering
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 9. Validate performance requirements
  - [ ]* 9.1 Benchmark face detector inference latency
    - Measure face detection time on WebGPU (target < 60ms)
    - Measure face detection time on WASM (target < 120ms)
    - _Requirements: 9.1, 9.2_
  
  - [ ]* 9.2 Measure FPS impact with dual models
    - Record baseline FPS with trash-only detection
    - Record FPS with face detection enabled
    - Verify FPS >= 90% of baseline
    - _Requirements: 9.3, 2.5_
  
  - [ ]* 9.3 Profile overlap suppression performance
    - Measure suppressOverlapping execution time
    - Verify < 5ms for typical box counts (up to 50 boxes)
    - _Requirements: 9.4_

- [ ] 10. Test long-range scanning compatibility
  - [ ]* 10.1 Verify face detection in long-range mode
    - Enable long-range tiled scanning
    - Verify face detector runs on full frame only
    - Verify overlap suppression applies to tile results
    - Verify face boxes display independently of tile visualization
    - _Requirements: 10.1, 10.2, 10.3, 10.4_
  
  - [ ]* 10.2 Measure performance impact on tile scanning
    - Record tile scan FPS baseline
    - Record tile scan FPS with face detection
    - Verify degradation < 10%
    - _Requirements: 10.5_

- [ ] 11. End-to-end validation and manual testing
  - [ ]* 11.1 Test face suppression accuracy
    - Point camera at person
    - Verify no trash labels appear on face
    - Verify face labeled as "Human" with yellow dotted box
    - _Requirements: 3.1, 3.2, 4.1, 4.2, 5.3_
  
  - [ ]* 11.2 Test dual tracking with mixed scenes
    - Frame with person and trash objects
    - Verify both face and trash tracked independently
    - Verify correct labels and colors for each
    - _Requirements: 6.1, 6.5_
  
  - [ ]* 11.3 Test graceful degradation
    - Simulate face detector unavailable
    - Verify trash detection continues
    - Verify status message indicates degraded mode
    - _Requirements: 8.1, 8.4, 8.5_
  
  - [ ]* 11.4 Cross-browser compatibility testing
    - Test on Chrome with WebGPU
    - Test on Firefox with WASM fallback
    - Test on Safari with WASM fallback
    - Verify consistent behavior across browsers
    - _Requirements: 9.1, 9.2_

- [x] 12. Final checkpoint - Complete integration validation
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation at logical breaks
- Face detector initialization uses existing `createFaceDetector` function from faceDetector.js
- Overlap suppression uses existing `overlapRatio` utility from detector.js
- BoxTracker already supports multiple object types, no modification needed
- Performance tests validate that dual-model operation meets latency and FPS targets
- Manual testing ensures end-to-end functionality and visual distinction

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2.1", "3.1"] },
    { "id": 2, "tasks": ["2.2", "3.2"] },
    { "id": 3, "tasks": ["3.3", "3.4"] },
    { "id": 4, "tasks": ["5.1"] },
    { "id": 5, "tasks": ["5.2", "5.3", "5.4"] },
    { "id": 6, "tasks": ["5.5", "6.1"] },
    { "id": 7, "tasks": ["6.2", "7.1", "7.2"] },
    { "id": 8, "tasks": ["9.1", "9.2", "9.3"] },
    { "id": 9, "tasks": ["10.1", "10.2"] },
    { "id": 10, "tasks": ["11.1", "11.2", "11.3", "11.4"] }
  ]
}
```
