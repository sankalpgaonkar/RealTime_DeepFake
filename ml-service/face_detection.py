"""
Face Detection Module
Detects and crops faces from images/frames using OpenCV YuNet DNN Face Detector
with robust fallback to Haar Cascade.

This module prioritizes OpenCV's deep learning-based YuNet detector (ONNX),
which is accurate, handles various lighting and angles, supports high-resolution
images without out-of-memory errors, and has near-zero false positives.

Accurate, well-framed face detection is CRITICAL for deepfake detection models
(such as SigLIP and EfficientNet) which are trained on cropped faces.
"""

import cv2
import numpy as np
from PIL import Image
import logging
import os
import urllib.request

logger = logging.getLogger(__name__)

# Global face detector
_face_detector = None
_detector_initialized = False
_detection_method = "none"

# YuNet model URL (ONNX) - official OpenCV Zoo release
YUNET_MODEL_URL = "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"

# Legacy OpenCV Caffe DNN model URLs
DNN_MODEL_URL = "https://raw.githubusercontent.com/opencv/opencv_3rdparty/dnn_samples_face_detector_20170830/res10_300x300_ssd_iter_140000.caffemodel"
DNN_CONFIG_URL = "https://raw.githubusercontent.com/opencv/opencv/master/samples/dnn/face_detector/deploy.prototxt"


def _download_file(url, filepath):
    """Download a file from URL if it doesn't exist"""
    if os.path.exists(filepath):
        return True
    try:
        logger.info(f'[FACE_DETECTION] Downloading: {url}')
        urllib.request.urlretrieve(url, filepath)
        logger.info(f'[FACE_DETECTION] Downloaded to: {filepath}')
        return True
    except Exception as e:
        logger.error(f'[FACE_DETECTION] Failed to download {url}: {e}')
        return False


def get_face_detector():
    """Get or initialize the face detector (singleton pattern)"""
    global _face_detector, _detector_initialized, _detection_method

    if _detector_initialized and _face_detector is not None:
        return _face_detector

    try:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        models_dir = os.path.join(script_dir, 'face_detection_models')
        os.makedirs(models_dir, exist_ok=True)

        _face_detector = None

        # 1. Try modern OpenCV YuNet ONNX (supported in OpenCV 4.5.4+ / 5.x)
        if hasattr(cv2, 'FaceDetectorYN'):
            yunet_path = os.path.join(models_dir, 'face_detection_yunet_2023mar.onnx')
            downloaded = _download_file(YUNET_MODEL_URL, yunet_path)
            if downloaded and os.path.exists(yunet_path):
                try:
                    _face_detector = cv2.FaceDetectorYN.create(
                        yunet_path, "", (320, 320), score_threshold=0.6, nms_threshold=0.3
                    )
                    _detection_method = "OpenCV YuNet ONNX"
                    logger.info(f'[FACE_DETECTION] {_detection_method} initialized successfully')
                except Exception as e:
                    logger.warning(f'[FACE_DETECTION] YuNet load failed ({e}), falling back...')
                    _face_detector = None

        # 2. Try legacy OpenCV Caffe DNN if available
        if _face_detector is None and hasattr(cv2.dnn, 'readNetFromCaffe'):
            model_path = os.path.join(models_dir, 'res10_300x300_ssd_iter_140000.caffemodel')
            config_path = os.path.join(models_dir, 'deploy.prototxt')
            model_downloaded = _download_file(DNN_MODEL_URL, model_path)
            config_downloaded = _download_file(DNN_CONFIG_URL, config_path)
            if model_downloaded and config_downloaded:
                try:
                    _face_detector = cv2.dnn.readNetFromCaffe(config_path, model_path)
                    _detection_method = "OpenCV DNN (SSD ResNet-10)"
                    logger.info(f'[FACE_DETECTION] {_detection_method} initialized')
                except Exception as e:
                    logger.warning(f'[FACE_DETECTION] Caffe DNN failed ({e}), falling back...')
                    _face_detector = None

        # 3. Fallback to OpenCV Haar Cascade (alt2 preferred over default)
        if _face_detector is None:
            logger.info('[FACE_DETECTION] Initializing Haar Cascade detector')
            alt2_file = cv2.data.haarcascades + "haarcascade_frontalface_alt2.xml"
            default_file = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
            cascade_file = alt2_file if os.path.exists(alt2_file) else default_file

            _face_detector = cv2.CascadeClassifier(cascade_file)
            if _face_detector.empty():
                # Try default as last ditch
                _face_detector = cv2.CascadeClassifier(default_file)

            if _face_detector.empty():
                logger.error('[FACE_DETECTION] Could not load Haar Cascade')
                _face_detector = None
                _detection_method = "none"
            else:
                _detection_method = f"OpenCV Haar Cascade ({os.path.basename(cascade_file)})"
                logger.info(f'[FACE_DETECTION] {_detection_method} initialized')

        _detector_initialized = True
        return _face_detector

    except Exception as e:
        logger.error(f'[FACE_DETECTION] Error initializing face detector: {str(e)}')
        _detector_initialized = True
        _face_detector = None
        _detection_method = "none"
        return None


def _detect_face_yunet(image_rgb, detector, min_confidence=0.5):
    """Detect faces using OpenCV YuNet"""
    h, w = image_rgb.shape[:2]
    detector.setInputSize((w, h))
    image_bgr = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2BGR)
    _, faces = detector.detect(image_bgr)

    if faces is None or len(faces) == 0:
        return None

    # Filter by confidence
    valid_faces = [f for f in faces if f[-1] >= min_confidence]
    if not valid_faces:
        return None

    # Return largest face by area (w * h)
    largest = max(valid_faces, key=lambda f: f[2] * f[3])
    x, y, fw, fh = int(largest[0]), int(largest[1]), int(largest[2]), int(largest[3])

    # Clamp coordinates
    x1 = max(0, x)
    y1 = max(0, y)
    fw = min(w - x1, fw)
    fh = min(h - y1, fh)

    if fw > 10 and fh > 10:
        return (x1, y1, fw, fh)
    return None


def _detect_face_dnn(image_rgb, net, confidence_threshold=0.3):
    """Detect faces using OpenCV Caffe DNN detector"""
    h, w = image_rgb.shape[:2]

    blob = cv2.dnn.blobFromImage(
        cv2.resize(image_rgb, (300, 300)),
        1.0,
        (300, 300),
        (104.0, 177.0, 123.0)
    )

    net.setInput(blob)
    detections = net.forward()

    faces = []
    for i in range(detections.shape[2]):
        confidence = detections[0, 0, i, 2]

        if confidence > confidence_threshold:
            box = detections[0, 0, i, 3:7] * np.array([w, h, w, h])
            x1, y1, x2, y2 = box.astype("int")

            x1 = max(0, x1)
            y1 = max(0, y1)
            x2 = min(w, x2)
            y2 = min(h, y2)

            if x2 > x1 and y2 > y1:
                faces.append((x1, y1, x2 - x1, y2 - y1, confidence))

    if not faces:
        return None

    largest_face = max(faces, key=lambda f: f[2] * f[3])
    return largest_face[:4]


def _detect_face_haar(gray, detector):
    """Detect faces using Haar Cascade with resolution-adaptive minimum size"""
    h, w = gray.shape[:2]
    min_dim = min(h, w)
    # Dynamic minSize: at least 6% of the smallest image dimension or 40px
    # This prevents tiny background noise patches on 4K/high-res photos from triggering false faces
    min_size = max(40, int(min_dim * 0.06))

    faces = detector.detectMultiScale(
        gray,
        scaleFactor=1.1,
        minNeighbors=5,
        minSize=(min_size, min_size)
    )

    if len(faces) == 0:
        return None

    # Get largest face by area
    largest_face = max(faces, key=lambda f: f[2] * f[3])
    return tuple(largest_face)


def detect_and_crop_multiscale(image, paddings=(10, 25, 50)):
    """
    Detect face in image once and return crops at multiple scale paddings.
    Provides robust detection across inner biometrics, facial boundaries, and contextual seams.

    Args:
        image: PIL Image or numpy array
        paddings: Tuple of padding percentages (default: 10% tight, 25% medium, 50% broad context)

    Returns:
        tuple: (list_of_PIL_Images, bool face_found)
    """
    try:
        if isinstance(image, Image.Image):
            image_np = np.array(image)
        else:
            image_np = image.copy()

        if len(image_np.shape) == 2:
            image_rgb = cv2.cvtColor(image_np, cv2.COLOR_GRAY2RGB)
        elif image_np.shape[2] == 4:
            image_rgb = cv2.cvtColor(image_np, cv2.COLOR_RGBA2RGB)
        else:
            image_rgb = image_np

        detector = get_face_detector()
        if detector is None:
            return [], False

        if _detection_method.startswith("OpenCV YuNet"):
            face_bbox = _detect_face_yunet(image_rgb, detector)
        elif _detection_method.startswith("OpenCV DNN"):
            face_bbox = _detect_face_dnn(image_rgb, detector)
        else:
            gray = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2GRAY)
            face_bbox = _detect_face_haar(gray, detector)

        if face_bbox is None:
            return [], False

        x, y, w, h = face_bbox
        img_h, img_w = image_rgb.shape[:2]
        center_x = x + w / 2.0
        center_y = y + h / 2.0
        max_dim = max(w, h)

        crops = []
        for pad in paddings:
            size = int(max_dim * (1.0 + pad / 100.0))
            half_size = size // 2
            x1 = max(0, int(center_x - half_size))
            y1 = max(0, int(center_y - half_size))
            x2 = min(img_w, int(center_x + half_size))
            y2 = min(img_h, int(center_y + half_size))

            crop_w = x2 - x1
            crop_h = y2 - y1
            actual_size = max(crop_w, crop_h)

            if crop_w < actual_size:
                if x1 == 0:
                    x2 = min(img_w, actual_size)
                elif x2 == img_w:
                    x1 = max(0, img_w - actual_size)

            if crop_h < actual_size:
                if y1 == 0:
                    y2 = min(img_h, actual_size)
                elif y2 == img_h:
                    y1 = max(0, img_h - actual_size)

            face_crop = image_rgb[y1:y2, x1:x2]
            crops.append(Image.fromarray(face_crop))

        logger.info(f'[FACE_DETECTION] Multi-scale extraction: {len(crops)} crops at paddings {paddings} via {_detection_method}')
        return crops, True

    except Exception as e:
        logger.error(f'[FACE_DETECTION] Error in multi-scale crop: {str(e)}')
        return [], False


def detect_and_crop_face(image, padding_percent=20, return_bbox=False):
    """
    Detect face in image and return cropped face.

    Args:
        image: PIL Image or numpy array
        padding_percent: Percentage of padding to add around face (default: 20%)
        return_bbox: If True, also return bounding box coordinates

    Returns:
        PIL Image of cropped face (or original image if no face detected)
        If return_bbox=True, returns (cropped_image, bbox) where bbox is (x, y, w, h) or None
    """
    try:
        # Convert PIL Image to numpy array if needed
        if isinstance(image, Image.Image):
            image_np = np.array(image)
        else:
            image_np = image.copy()

        # Ensure RGB format
        if len(image_np.shape) == 2:
            image_rgb = cv2.cvtColor(image_np, cv2.COLOR_GRAY2RGB)
        elif image_np.shape[2] == 4:
            image_rgb = cv2.cvtColor(image_np, cv2.COLOR_RGBA2RGB)
        else:
            image_rgb = image_np

        # Get face detector
        detector = get_face_detector()

        if detector is None:
            logger.warning('[FACE_DETECTION] Detector not available, using full image')
            if return_bbox:
                return Image.fromarray(image_rgb), None
            return Image.fromarray(image_rgb)

        # Detect face using appropriate method
        if _detection_method.startswith("OpenCV YuNet"):
            face_bbox = _detect_face_yunet(image_rgb, detector)
        elif _detection_method.startswith("OpenCV DNN"):
            face_bbox = _detect_face_dnn(image_rgb, detector)
        else:
            gray = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2GRAY)
            face_bbox = _detect_face_haar(gray, detector)

        if face_bbox is None:
            logger.warning(f'[FACE_DETECTION] No face detected in image of size {image_rgb.shape}')
            if return_bbox:
                return Image.fromarray(image_rgb), None
            return Image.fromarray(image_rgb)

        x, y, w, h = face_bbox
        img_h, img_w = image_rgb.shape[:2]

        # Calculate square bounding box with moderate padding (default 12%)
        center_x = x + w / 2.0
        center_y = y + h / 2.0
        max_dim = max(w, h)
        size = int(max_dim * (1.0 + padding_percent / 100.0))

        half_size = size // 2
        x1 = max(0, int(center_x - half_size))
        y1 = max(0, int(center_y - half_size))
        x2 = min(img_w, int(center_x + half_size))
        y2 = min(img_h, int(center_y + half_size))

        # Maintain square aspect ratio if possible
        crop_w = x2 - x1
        crop_h = y2 - y1
        actual_size = max(crop_w, crop_h)

        if crop_w < actual_size:
            if x1 == 0:
                x2 = min(img_w, actual_size)
            elif x2 == img_w:
                x1 = max(0, img_w - actual_size)

        if crop_h < actual_size:
            if y1 == 0:
                y2 = min(img_h, actual_size)
            elif y2 == img_h:
                y1 = max(0, img_h - actual_size)

        face_crop = image_rgb[y1:y2, x1:x2]
        face_image = Image.fromarray(face_crop)

        logger.info(f'[FACE_DETECTION] Face cropped to ({x1},{y1},{x2-x1},{y2-y1}) via {_detection_method}')

        if return_bbox:
            return face_image, (x1, y1, x2 - x1, y2 - y1)
        return face_image

    except Exception as e:
        logger.error(f'[FACE_DETECTION] Error detecting face: {str(e)}')
        if len(image_np.shape) == 3:
            image_rgb = image_np
        else:
            image_rgb = cv2.cvtColor(image_np, cv2.COLOR_GRAY2RGB)
        if return_bbox:
            return Image.fromarray(image_rgb), None
        return Image.fromarray(image_rgb)


def detect_faces_in_frame(frame, min_confidence=0.5):
    """
    Detect all faces in a frame.

    Args:
        frame: numpy array (RGB format)
        min_confidence: minimum detection confidence

    Returns:
        List of bounding boxes [(x, y, w, h), ...]
    """
    try:
        detector = get_face_detector()
        if detector is None:
            return []

        # Ensure RGB format
        if len(frame.shape) == 2:
            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_GRAY2RGB)
        elif frame.shape[2] == 4:
            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_RGBA2RGB)
        else:
            frame_rgb = frame

        h, w = frame_rgb.shape[:2]

        if _detection_method.startswith("OpenCV YuNet"):
            detector.setInputSize((w, h))
            frame_bgr = cv2.cvtColor(frame_rgb, cv2.COLOR_RGB2BGR)
            _, detections = detector.detect(frame_bgr)
            faces = []
            if detections is not None:
                for f in detections:
                    if f[-1] >= min_confidence:
                        fx, fy, fw, fh = int(f[0]), int(f[1]), int(f[2]), int(f[3])
                        faces.append((max(0, fx), max(0, fy), min(w - max(0, fx), fw), min(h - max(0, fy), fh)))
            return faces

        elif _detection_method.startswith("OpenCV DNN"):
            blob = cv2.dnn.blobFromImage(
                cv2.resize(frame_rgb, (300, 300)),
                1.0,
                (300, 300),
                (104.0, 177.0, 123.0)
            )
            detector.setInput(blob)
            detections = detector.forward()

            faces = []
            for i in range(detections.shape[2]):
                confidence = detections[0, 0, i, 2]
                if confidence > min_confidence:
                    box = detections[0, 0, i, 3:7] * np.array([w, h, w, h])
                    x1, y1, x2, y2 = box.astype("int")
                    x1, y1 = max(0, x1), max(0, y1)
                    x2, y2 = min(w, x2), min(h, y2)
                    if x2 > x1 and y2 > y1:
                        faces.append((x1, y1, x2 - x1, y2 - y1))
            return faces
        else:
            # Haar Cascade fallback
            gray = cv2.cvtColor(frame_rgb, cv2.COLOR_RGB2GRAY)
            min_dim = min(h, w)
            min_size = max(40, int(min_dim * 0.06))
            faces = detector.detectMultiScale(
                gray,
                scaleFactor=1.1,
                minNeighbors=5,
                minSize=(min_size, min_size)
            )
            return [(int(x), int(y), int(w), int(h)) for x, y, w, h in faces]

    except Exception as e:
        logger.error(f'[FACE_DETECTION] Error detecting faces in frame: {str(e)}')
        return []


def get_largest_face(image):
    """Detect and return the largest face in the image"""
    return detect_and_crop_face(image, padding_percent=12, return_bbox=False)


def get_detection_method():
    """Return the current face detection method being used"""
    global _detection_method
    if not _detector_initialized:
        get_face_detector()
    return _detection_method
