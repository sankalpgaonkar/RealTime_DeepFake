"""
ML Service - Flask API for Deepfake Detection
High-accuracy deepfake detection using:
- Image model: deepfake-detector-model-v1 (94.44% accuracy)
- Audio model: wav2vec2-large-xlsr-deepfake-audio-classification (92.86% accuracy)

This service:
1. Loads deepfake detection models (image and audio)
2. Preprocesses media files (frames, images, audio)
3. Runs inference on the models
4. Returns combined detection scores
"""

import os
import time
import json
import shutil
import tempfile
import numpy as np
from PIL import Image
from flask import Flask, request, jsonify
from flask_cors import CORS
import logging
from datetime import datetime

# Import our modules
from model_loader import (
    get_pipeline, is_model_loaded, load_model, get_model_info,
    get_audio_pipeline, is_audio_model_loaded, load_audio_model,
    hot_swap_model
)
from trainer import start_training, get_training_status
from dataset_builder import get_dataset_stats
from preprocessing import preprocess_image, preprocess_image_multiscale, preprocess_frames
from audio_preprocessing import preprocess_audio, is_audio_processing_available
from detection_calibration import aggregate_image_probability, extract_fake_probability as calibrate_fake_probability

app = Flask(__name__)
CORS(app)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Global model status
_model_loaded = False
_model_status = 'loading'
_model_load_error = None

# ---------------------------------------------------------------------------
# Inference configuration — all thresholds driven by environment variables.
# No magic numbers in inference logic below.
# ---------------------------------------------------------------------------
INFERENCE_CONFIG = {
    # Maximum frames to process per request (caller can send fewer via maxFrames)
    'max_frames': int(os.environ.get('ML_MAX_FRAMES', '120')),
    # Audio/video fusion weights (must sum to 1.0)
    'video_weight': float(os.environ.get('ML_VIDEO_WEIGHT', '0.60')),
    'audio_weight': float(os.environ.get('ML_AUDIO_WEIGHT', '0.40')),
    # Confidence penalties for low face-detection rates
    'face_penalty_very_low': float(os.environ.get('ML_FACE_PENALTY_VERY_LOW', '0.20')),   # <30% face rate
    'face_penalty_low':      float(os.environ.get('ML_FACE_PENALTY_LOW',      '0.10')),   # <50% face rate
    'face_penalty_moderate': float(os.environ.get('ML_FACE_PENALTY_MODERATE', '0.05')),   # <70% face rate
    # Face-detection rate thresholds that trigger the penalties above
    'face_rate_very_low': float(os.environ.get('ML_FACE_RATE_VERY_LOW', '0.30')),
    'face_rate_low':      float(os.environ.get('ML_FACE_RATE_LOW',      '0.50')),
    'face_rate_moderate': float(os.environ.get('ML_FACE_RATE_MODERATE', '0.70')),
    # Blend fraction of peak_risk added to risk_score when peak is much higher
    'peak_blend_fraction': float(os.environ.get('ML_PEAK_BLEND_FRACTION', '0.30')),
    'peak_blend_gap':      float(os.environ.get('ML_PEAK_BLEND_GAP',      '10.0')),
}


def resolve_file_path(p):
    """Resolve file path across native and docker environments."""
    if not p or not isinstance(p, str):
        return p
    if os.path.exists(p):
        return os.path.abspath(p)
    base_dir = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(base_dir, '..', p),
        os.path.join(base_dir, '..', 'backend', p),
        os.path.join(base_dir, '..', 'backend', 'uploads', os.path.basename(p)),
        os.path.join(base_dir, 'uploads', os.path.basename(p)),
    ]
    for c in candidates:
        if os.path.exists(c):
            return os.path.abspath(c)
    return p


def load_model_on_startup():
    """Load models when service starts.

    The image model loads in a background thread; the audio model loads only when
    requested. The web process can pass Render health checks while models warm up.
    """
    import threading
    global _model_loaded, _model_status, _model_load_error

    # Keep Gunicorn startup fast. Render health checks remain available while models
    # are downloaded in a daemon thread instead of blocking process initialization.
    def _preload_image():
        global _model_loaded
        try:
            logger.info('[ML_SERVICE] Loading image model in background thread...')
            load_model()
            _model_loaded = True
            _model_status = 'loaded'
            _model_load_error = None
            logger.info('[ML_SERVICE] Image model loaded successfully')
        except Exception as e:
            logger.error(f'[ML_SERVICE] Failed to load image model: {str(e)}', exc_info=True)
            _model_loaded = False
            _model_status = 'failed'
            _model_load_error = str(e)

    image_thread = threading.Thread(target=_preload_image, daemon=True, name='image-model-loader')
    image_thread.start()

    logger.info('[ML_SERVICE] Audio model will load on the first audio inference request')


def extract_fake_probability(result):
    """
    Extract the fake probability from model result
    Model returns: Class 0 = 'fake', Class 1 = 'real'

    Args:
        result: Single prediction result from pipeline

    Returns:
        Float probability that the image is fake (0-1)
    """
    try:
        return calibrate_fake_probability(result)
    except Exception as e:
        logger.error(f'[ML_SERVICE] Error extracting fake probability: {str(e)}')
        return 0.5


def extract_audio_fake_probability(result):
    """
    Extract fake probability from audio model result
    Model returns labels like 'fake', 'real', 'bonafide', 'spoof'

    Args:
        result: Prediction result from audio pipeline

    Returns:
        Float probability that audio is fake (0-1)
    """
    try:
        if isinstance(result, list):
            for item in result:
                label = item.get('label', '').lower()
                score = item.get('score', 0.0)

                # Handle various label formats from audio models
                if 'fake' in label or 'spoof' in label:
                    return score
                elif 'real' in label or 'bonafide' in label:
                    return 1.0 - score

            # Fallback: use first result
            if len(result) > 0:
                top_result = result[0]
                label = top_result.get('label', '').lower()
                score = top_result.get('score', 0.5)

                if 'fake' in label or 'spoof' in label:
                    return score
                else:
                    return 1.0 - score

        return 0.5  # Uncertain

    except Exception as e:
        logger.error(f'[ML_SERVICE] Error extracting audio fake probability: {str(e)}')
        return 0.5


def run_audio_inference(audio_data):
    """
    Run inference on preprocessed audio

    Args:
        audio_data: dict from preprocess_audio containing 'audio' and 'sample_rate'

    Returns:
        tuple: (fake_probability, raw_result) or (None, None) on failure
    """
    try:
        audio_pipeline = get_audio_pipeline()
        if audio_pipeline is None:
            logger.warning('[ML_SERVICE] Audio pipeline not available')
            return None, None

        if not audio_data.get('valid') or audio_data.get('audio') is None:
            logger.warning(f'[ML_SERVICE] Invalid audio data: {audio_data.get("error")}')
            return None, None

        # Prepare input for pipeline
        # HuggingFace audio-classification expects dict with 'array' and 'sampling_rate'
        audio_input = {
            'array': audio_data['audio'],
            'sampling_rate': audio_data['sample_rate']
        }

        # Run inference
        raw_result = audio_pipeline(audio_input)

        # Extract fake probability
        fake_prob = extract_audio_fake_probability(raw_result)

        logger.info(f'[ML_SERVICE] Audio inference complete: fake_prob={fake_prob:.4f}')

        return fake_prob, raw_result

    except Exception as e:
        logger.error(f'[ML_SERVICE] Audio inference error: {str(e)}', exc_info=True)
        return None, None


def run_inference(pipeline, images):
    """
    Run inference on preprocessed images using pipeline

    Args:
        pipeline: Loaded pipeline
        images: List of PIL Images or single PIL Image

    Returns:
        List of predictions with probabilities
    """
    try:
        # Run inference
        raw_results = pipeline(images)

        # Normalize results to list of predictions
        # Each prediction is a list of {label, score} dicts
        results = []

        if isinstance(raw_results, dict):
            # Single dict result
            results = [[raw_results]]
        elif isinstance(raw_results, list) and len(raw_results) > 0:
            if isinstance(raw_results[0], dict) and 'label' in raw_results[0]:
                # Single image result: [{'label': 'Real', 'score': 0.51}, {'label': 'Fake', 'score': 0.49}]
                results = [raw_results]
            elif isinstance(raw_results[0], list):
                # Batch result: [[{...}, {...}], [{...}, {...}]]
                results = raw_results
            else:
                # Unknown format, wrap it
                results = [raw_results]
        else:
            # Empty or unknown, use default
            results = [raw_results]

        # Extract fake probabilities - each result is a full prediction with all labels
        fake_probs = [extract_fake_probability(result) for result in results]

        return fake_probs, raw_results

    except Exception as e:
        logger.error(f'[ML_SERVICE] Model inference error: {str(e)}', exc_info=True)
        raise


def compute_gan_fingerprint(fake_probs, video_score):
    """
    Compute a GAN-fingerprint score that is distinct from the raw video_score.

    Rather than copying video_score verbatim, this measures the *localised spike*
    pattern that is characteristic of GAN-generated regions:
      - A genuine deepfake tends to produce inconsistent per-frame scores with
        high-confidence outlier frames (the manipulated segments).
      - An authentic video tends to produce uniformly low or uniformly moderate
        scores with little variance.

    Formula:
        fingerprint = (peak_prob - mean_prob) * 200   (clamped to 0–100)
    For single-frame inputs (image/no multi-frame), falls back to video_score.

    Args:
        fake_probs: list/array of per-frame fake probabilities [0, 1]
        video_score: already-computed P90 video score (0–100), used as fallback

    Returns:
        float 0–100 representing estimated GAN-artifact level
    """
    if fake_probs is None or len(fake_probs) < 2:
        # Single frame — no temporal spike possible; use model score directly
        return float(video_score)

    arr = np.array(fake_probs)
    mean_prob = float(np.mean(arr))
    peak_prob = float(np.max(arr))

    # Spike magnitude: how much the worst frame exceeds the average
    spike = peak_prob - mean_prob  # range [0, ~1]

    # Scale: spike of 0.5 → fingerprint of 100 (extreme localised anomaly)
    fingerprint = min(100.0, spike * 200.0)

    # Blend with video_score so the fingerprint also reflects the overall model signal
    # (prevents very high spike on low-probability noise from inflating the score)
    blended = fingerprint * 0.6 + video_score * 0.4

    return round(max(0.0, min(100.0, blended)), 2)


def calculate_scores(fake_probs, media_type, frame_count=1, faces_detected=0, audio_fake_prob=None, image_full_prob=None, image_crop_probs=None):
    """
    Calculate detection scores from model predictions

    Args:
        fake_probs: List of fake probabilities (from video/image)
        media_type: Type of media (VIDEO, IMAGE, AUDIO)
        frame_count: Number of frames processed
        faces_detected: Number of frames with detected faces
        audio_fake_prob: Audio fake probability (0-1) or None if not available
        image_full_prob: Full image fake probability for IMAGE media type
        image_crop_probs: Multi-scale facial crops fake probabilities for IMAGE media type

    Returns:
        Dictionary of calculated scores
    """
    try:
        # Specialized Dual-Signal Pipeline for Single IMAGE
        if media_type == 'IMAGE':
            fake_probs_arr = np.array(fake_probs) if len(fake_probs) > 0 else np.array([])
            if image_crop_probs is not None and len(image_crop_probs) > 0:
                image_scores = aggregate_image_probability(
                    full_probability=image_full_prob if image_full_prob is not None else 0.0,
                    crop_probabilities=image_crop_probs,
                )
                video_score = image_scores["risk_probability"] * 100
                peak_risk = image_scores["peak_probability"] * 100
                mean_risk = image_scores["mean_probability"] * 100
            elif len(fake_probs_arr) > 0:
                video_score = float(fake_probs_arr[0] * 100)
                peak_risk = video_score
                mean_risk = video_score
            else:
                video_score = 0.0
                peak_risk = 0.0
                mean_risk = 0.0

            risk_score = video_score
            gan_fingerprint = float(video_score)
            temporal_consistency = 100.0
            confidence = float(np.mean([abs(p - 0.5) * 2 for p in fake_probs_arr]) * 100) if len(fake_probs_arr) > 0 else 0.0

            logger.info(f'[ML_SERVICE] Image Scores: Composite={video_score:.2f}, Peak={peak_risk:.2f}, Risk={risk_score:.2f}, Confidence={confidence:.2f}')

            return {
                'video_score': round(video_score, 2),
                'peak_risk': round(peak_risk, 2),
                'mean_risk': round(mean_risk, 2),
                'audio_score': 0.0,
                'gan_fingerprint': round(gan_fingerprint, 2),
                'temporal_consistency': 100.0,
                'risk_score': round(risk_score, 2),
                'confidence': round(confidence, 2),
                'faces_detected': faces_detected,
                'total_frames': frame_count
            }

        fake_probs = np.array(fake_probs) if len(fake_probs) > 0 else np.array([])

        if len(fake_probs) > 0:
            logger.info(f'[ML_SERVICE] Video fake probabilities: {fake_probs[:min(5, len(fake_probs))]}...')

        # Calculate video scores using 90th percentile (P90) for robustness
        if len(fake_probs) > 0 and fake_probs.max() > 0:
            video_score = float(np.percentile(fake_probs, 90) * 100)
            peak_risk = float(np.max(fake_probs) * 100)
            mean_risk = float(np.mean(fake_probs) * 100)
        else:
            video_score = 0.0
            peak_risk = 0.0
            mean_risk = 0.0

        # GAN fingerprint: measures localised spike pattern (distinct from video_score)
        gan_fingerprint = compute_gan_fingerprint(fake_probs.tolist(), video_score)

        # Temporal consistency for videos
        # variance is in [0, 0.25] for probabilities in [0, 1].
        # We normalise by the theoretical maximum (0.25) so the formula is:
        #   consistency = 100 * (1 - variance / 0.25) = 100 * (1 - variance * 4)
        # This gives: variance=0 → 100%, variance=0.1 → 60%, variance=0.25 → 0%
        if media_type == 'VIDEO' and len(fake_probs) > 1:
            variance = float(np.var(fake_probs))
            temporal_consistency = max(0.0, min(100.0, 100.0 * (1.0 - variance * 4.0)))
        else:
            temporal_consistency = 100.0

        # Audio score: calculate from audio_fake_prob if available
        if audio_fake_prob is not None:
            audio_score = float(audio_fake_prob * 100)
            logger.info(f'[ML_SERVICE] Audio score: {audio_score:.2f}%')
        else:
            audio_score = 0.0

        # Calculate confidence (how certain the model is)
        # Use the average of how far predictions are from 0.5 (uncertain)
        if len(fake_probs) > 0:
            confidence = float(np.mean([abs(p - 0.5) * 2 for p in fake_probs]) * 100)
        elif audio_fake_prob is not None:
            # Audio-only: use audio confidence
            confidence = float(abs(audio_fake_prob - 0.5) * 2 * 100)
        else:
            confidence = 0.0

        # Apply confidence penalty based on face detection rate.
        # All thresholds and penalties come from INFERENCE_CONFIG (env-var driven).
        if frame_count > 0:
            face_detection_rate = faces_detected / frame_count
            confidence_penalty = 0.0

            if face_detection_rate < INFERENCE_CONFIG['face_rate_very_low']:
                confidence_penalty = INFERENCE_CONFIG['face_penalty_very_low']
                logger.warning(
                    f'[ML_SERVICE] Very low face detection rate: {face_detection_rate:.1%} '
                    f'— applying {confidence_penalty:.0%} confidence penalty'
                )
            elif face_detection_rate < INFERENCE_CONFIG['face_rate_low']:
                confidence_penalty = INFERENCE_CONFIG['face_penalty_low']
                logger.warning(
                    f'[ML_SERVICE] Low face detection rate: {face_detection_rate:.1%} '
                    f'— applying {confidence_penalty:.0%} confidence penalty'
                )
            elif face_detection_rate < INFERENCE_CONFIG['face_rate_moderate']:
                confidence_penalty = INFERENCE_CONFIG['face_penalty_moderate']
                logger.info(
                    f'[ML_SERVICE] Moderate face detection rate: {face_detection_rate:.1%} '
                    f'— applying {confidence_penalty:.0%} confidence penalty'
                )

            if confidence_penalty > 0:
                original_confidence = confidence
                confidence = confidence * (1.0 - confidence_penalty)
                logger.info(f'[ML_SERVICE] Confidence adjusted: {original_confidence:.2f}% → {confidence:.2f}%')

        # Zero-face guardrail:
        # If no faces were detected in video media, facial deepfake models cannot perform analysis.
        # Spurious background patches must never be classified as deepfakes.
        if media_type == 'VIDEO' and faces_detected == 0:
            logger.warning('[ML_SERVICE] Zero faces detected in video. Suppressing facial risk score.')
            video_score = 0.0
            peak_risk = 0.0
            mean_risk = 0.0
            gan_fingerprint = 0.0
            temporal_consistency = 100.0
            if media_type == 'VIDEO' and audio_fake_prob is not None:
                audio_score = float(audio_fake_prob * 100)
                risk_score = audio_score
                confidence = float(abs(audio_fake_prob - 0.5) * 2 * 100)
            else:
                risk_score = 0.0
                confidence = 0.0
        else:
            # Calculate combined risk score — weights from INFERENCE_CONFIG
            v_w = INFERENCE_CONFIG['video_weight']
            a_w = INFERENCE_CONFIG['audio_weight']

            if media_type == 'VIDEO' and audio_score > 0:
                # VIDEO with audio: weighted combination.
                # Only escalate if visual media also shows suspicion (video_score >= 40);
                # pristine facial video (video_score < 30) avoids false positives from noisy audio.
                weighted_score = (video_score * v_w) + (audio_score * a_w)
                if audio_score >= 80 and video_score >= 40:
                    risk_score = max(weighted_score, audio_score * 0.8)
                else:
                    risk_score = weighted_score
                logger.info(f'[ML_SERVICE] Combined video+audio risk: weighted={weighted_score:.2f}, final={risk_score:.2f}')
            elif media_type == 'AUDIO':
                # AUDIO only: use audio score directly
                risk_score = audio_score
            else:
                # VIDEO/IMAGE without audio: use video score
                risk_score = video_score

            # If the peak is significantly above the current risk score, blend it in
            # (catches localized deepfake segments that the P90 metric may underweight)
            peak_gap = INFERENCE_CONFIG['peak_blend_gap']
            peak_fraction = INFERENCE_CONFIG['peak_blend_fraction']
            if peak_risk > risk_score + peak_gap:
                risk_score = risk_score * (1.0 - peak_fraction) + peak_risk * peak_fraction

        risk_score = min(100, max(0, risk_score))

        logger.info(f'[ML_SERVICE] Scores: Video={video_score:.2f}, Audio={audio_score:.2f}, Peak={peak_risk:.2f}, Risk={risk_score:.2f}, Confidence={confidence:.2f}')

        return {
            'video_score': round(video_score, 2),
            'peak_risk': round(peak_risk, 2),
            'mean_risk': round(mean_risk, 2),
            'audio_score': round(audio_score, 2),
            'gan_fingerprint': round(gan_fingerprint, 2),
            'temporal_consistency': round(temporal_consistency, 2),
            'risk_score': round(risk_score, 2),
            'confidence': round(confidence, 2),
            'faces_detected': faces_detected,
            'total_frames': frame_count
        }

    except Exception as e:
        logger.error(f'[ML_SERVICE] Score calculation error: {str(e)}', exc_info=True)
        raise


@app.route('/', methods=['GET'])
def index():
    """Root status and service info endpoint"""
    model_info = get_model_info()
    return jsonify({
        'status': 'unhealthy' if _model_status == 'failed' else 'healthy',
        'service': 'deepfake-detection-ml-service',
        'version': '4.1.0',
        'message': 'Deepfake Detection ML Inference Service is running',
        'endpoints': {
            'root': '/',
            'health': '/health',
            'inference': '/api/v1/inference (POST)',
            'training_status': '/api/v1/training/status (GET)',
            'retrain': '/api/v1/retrain (POST)',
        },
        'models': {
            'image': model_info.get('model'),
            'image_accuracy': model_info.get('accuracy'),
            'audio': model_info.get('audio_model'),
            'audio_accuracy': model_info.get('audio_accuracy'),
        },
        'timestamp': datetime.utcnow().isoformat()
    }), 200


@app.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint"""
    model_info = get_model_info()
    return jsonify({
        'status': 'healthy' if _model_loaded else 'unhealthy',
        'service': 'deepfake-detection-ml-service',
        'version': '4.1.0',
        # Image model info
        'model': model_info['model'],
        'model_status': _model_status,
        'model_error': _model_load_error,
        'accuracy': model_info['accuracy'],
        'architecture': model_info['architecture'],
        'device': model_info['device'],
        # Audio model info
        'audio_model': model_info.get('audio_model'),
        'audio_model_status': 'loaded' if model_info.get('audio_model_loaded') else 'not_loaded',
        'audio_accuracy': model_info.get('audio_accuracy'),
        'audio_processing_available': is_audio_processing_available(),
        'timestamp': datetime.utcnow().isoformat()
    }), 503 if _model_status == 'failed' else 200


@app.route('/api/v1/inference', methods=['POST'])
def inference():
    """
    Deepfake detection inference endpoint
    """
    start_time = time.time()
    inference_temp_dir = None

    try:
        if request.mimetype == 'multipart/form-data':
            try:
                data = json.loads(request.form.get('metadata', '{}'))
            except json.JSONDecodeError as error:
                return jsonify({'error': 'Invalid request', 'message': f'Invalid metadata JSON: {error}'}), 400

            inference_temp_dir = tempfile.mkdtemp(prefix='ml-inference-')
            extracted_frames = []
            for index, uploaded_frame in enumerate(request.files.getlist('frames')):
                extension = os.path.splitext(uploaded_frame.filename or '')[1].lower()
                if extension not in {'.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff', '.tif'}:
                    extension = '.jpg'
                frame_path = os.path.join(inference_temp_dir, f'frame_{index:04d}{extension}')
                uploaded_frame.save(frame_path)
                extracted_frames.append(frame_path)

            uploaded_audio = request.files.get('audio')
            extracted_audio = None
            if uploaded_audio:
                extension = os.path.splitext(uploaded_audio.filename or '')[1].lower()
                if extension not in {'.wav', '.mp3', '.m4a', '.aac', '.ogg', '.flac', '.opus'}:
                    extension = '.wav'
                extracted_audio = os.path.join(inference_temp_dir, f'audio{extension}')
                uploaded_audio.save(extracted_audio)
        else:
            data = request.get_json()
            extracted_frames = data.get('extractedFrames', []) if data else []
            extracted_audio = data.get('extractedAudio') if data else None

        if not isinstance(data, dict) or not data:
            return jsonify({
                'error': 'Invalid request',
                'message': 'Request body must contain a JSON object'
            }), 400

        if not _model_loaded:
            return jsonify({
                'error': 'Service Unavailable',
                'message': 'Model is not loaded'
            }), 503

        hash_value = data.get('hash', '')
        media_type = data.get('mediaType', 'UNKNOWN')
        model_version = data.get('modelVersion', 'v4')
        if request.mimetype != 'multipart/form-data':
            extracted_frames = data.get('extractedFrames', [])
            extracted_audio = data.get('extractedAudio', None)

        # max_frames: caller (perception agent) sends how many frames it extracted.
        # We respect that value but clamp to our service ceiling (INFERENCE_CONFIG['max_frames']).
        # If the caller doesn't send it (None / absent), process all provided frames.
        caller_max_frames = data.get('maxFrames', None)
        if caller_max_frames and isinstance(caller_max_frames, int) and caller_max_frames > 0:
            max_frames = min(caller_max_frames, INFERENCE_CONFIG['max_frames'])
        else:
            max_frames = INFERENCE_CONFIG['max_frames']

        logger.info(f'[ML_SERVICE] Inference request: hash={hash_value[:16] if hash_value else "none"}..., type={media_type}, model={model_version}')

        # Get pipeline
        pipeline = get_pipeline()

        # Track face detection
        faces_detected = 0
        total_frames = 0

        # Process based on media type
        if media_type == 'IMAGE':
            if not extracted_frames:
                raise ValueError('No frame paths provided for IMAGE')

            # Process first frame as image
            raw_path = extracted_frames[0] if isinstance(extracted_frames, list) else extracted_frames
            image_path = resolve_file_path(raw_path)
            
            # Validate path exists
            if not os.path.exists(image_path):
                raise ValueError(f'Image file not found: {image_path}')
            
            # Multi-scale face crop ensemble (10% tight, 25% medium, 50% broad context)
            # Evaluates inner biometrics, facial perimeter seams, and diffusion boundaries
            crops, face_found = preprocess_image_multiscale(image_path, paddings=(10, 25, 50))
            total_frames = 1
            faces_detected = 1 if face_found else 0

            # Whole-image evaluation: evaluates global diffusion patterns, background rendering, and generative textures
            full_pil = Image.open(image_path).convert('RGB')
            eval_images = [full_pil]
            if face_found and crops:
                eval_images.extend(crops)

            # Run inference across full image + multi-scale face crops
            fake_probs, results = run_inference(pipeline, eval_images)
            full_fake_prob = fake_probs[0]
            crop_fake_probs = fake_probs[1:] if len(fake_probs) > 1 else []

            logger.info(
                f'[ML_SERVICE] Image inference: full_img={full_fake_prob*100:.1f}%, '
                f'crops={[f"{p*100:.1f}%" for p in crop_fake_probs]}, face_found={face_found}'
            )

            scores = calculate_scores(
                fake_probs=fake_probs,
                media_type=media_type,
                frame_count=1,
                faces_detected=faces_detected,
                image_full_prob=full_fake_prob,
                image_crop_probs=crop_fake_probs
            )

        elif media_type == 'VIDEO':
            if not extracted_frames:
                raise ValueError('No frame paths provided for VIDEO')

            # Validate frame paths exist
            valid_paths = []
            for frame_path in extracted_frames:
                resolved_frame = resolve_file_path(frame_path)
                if os.path.exists(resolved_frame):
                    valid_paths.append(resolved_frame)
                else:
                    logger.warning(f'[ML_SERVICE] Frame file not found: {frame_path}')

            if not valid_paths:
                raise ValueError('No valid frame files found')

            # Process frames — use return_face_counts=True to get real face detection results
            # instead of guessing via aspect-ratio (which was always wrong).
            images, valid_frames, faces_detected = preprocess_frames(
                valid_paths, max_frames=max_frames, return_face_counts=True
            )

            if not images or len(valid_frames) == 0:
                raise ValueError('No valid frames processed')

            total_frames = len(valid_frames)
            processed_images = images

            logger.info(
                f'[ML_SERVICE] Preprocessed {total_frames} frames, '
                f'{faces_detected} faces detected ({faces_detected/total_frames:.1%} rate)'
            )

            # Run video/image inference on all frames
            fake_probs, results = run_inference(pipeline, processed_images)

            # Process audio if available
            audio_fake_prob = None
            resolved_audio = resolve_file_path(extracted_audio) if extracted_audio else None
            if resolved_audio and os.path.exists(resolved_audio):
                logger.info(f'[ML_SERVICE] Processing audio track: {resolved_audio}')

                if is_audio_processing_available():
                    audio_data = preprocess_audio(resolved_audio)
                    if audio_data['valid']:
                        audio_fake_prob, audio_raw = run_audio_inference(audio_data)
                        if audio_fake_prob is not None:
                            logger.info(f'[ML_SERVICE] Audio analysis complete: fake_prob={audio_fake_prob:.4f}')
                        else:
                            logger.warning('[ML_SERVICE] Audio inference returned None')
                    else:
                        logger.warning(f'[ML_SERVICE] Audio preprocessing failed: {audio_data.get("error")}')
                else:
                    logger.info('[ML_SERVICE] Audio model not available, skipping audio analysis')
            else:
                logger.info('[ML_SERVICE] No audio track provided for video')

            # Calculate combined scores (video + audio)
            scores = calculate_scores(
                fake_probs,
                media_type,
                frame_count=len(valid_frames),
                faces_detected=faces_detected,
                audio_fake_prob=audio_fake_prob
            )

        elif media_type == 'AUDIO':
            # Standalone audio deepfake detection
            if not is_audio_processing_available():
                raise ValueError('Audio processing not available - librosa not installed')

            # Get audio path (either extracted or direct upload)
            audio_path = extracted_audio
            if not audio_path and extracted_frames:
                # For direct audio uploads, the path might be in extractedFrames
                audio_path = extracted_frames[0] if isinstance(extracted_frames, list) else extracted_frames

            audio_path = resolve_file_path(audio_path) if audio_path else None
            if not audio_path or not os.path.exists(audio_path):
                raise ValueError('No valid audio file provided')

            logger.info(f'[ML_SERVICE] Processing audio file: {audio_path}')

            # Preprocess audio
            audio_data = preprocess_audio(audio_path)
            if not audio_data['valid']:
                raise ValueError(f'Audio preprocessing failed: {audio_data.get("error")}')

            # Run audio inference
            audio_fake_prob, audio_raw = run_audio_inference(audio_data)
            if audio_fake_prob is None:
                raise ValueError('Audio inference failed')

            # Calculate scores (video scores will be 0 for audio-only)
            scores = calculate_scores(
                fake_probs=[],  # No video frames
                media_type=media_type,
                frame_count=0,
                faces_detected=0,
                audio_fake_prob=audio_fake_prob
            )

        else:
            raise ValueError(f'Unknown media type: {media_type}')

        # Calculate inference time
        inference_time = int((time.time() - start_time) * 1000)

        # Get model info for version tracking
        model_info = get_model_info()

        # Build response
        response = {
            **scores,
            'model_version': model_info['model_version'],
            'model_name': model_info['model_name'],
            'inference_time': inference_time
        }

        # Add warning if no faces detected
        if faces_detected == 0 and media_type != 'AUDIO':
            response['warning'] = 'No human faces detected. Facial authenticity verification requires a clearly visible face.'

        logger.info(f'[ML_SERVICE] Inference complete: risk_score={response["risk_score"]}, confidence={response["confidence"]}, faces={faces_detected}/{total_frames}, time={inference_time}ms')

        return jsonify(response), 200

    except Exception as e:
        logger.error(f'[ML_SERVICE] Inference error: {str(e)}', exc_info=True)
        return jsonify({
            'error': 'Inference failed',
            'message': str(e)
        }), 500
    finally:
        if inference_temp_dir:
            shutil.rmtree(inference_temp_dir, ignore_errors=True)


@app.route('/api/v1/retrain', methods=['POST'])
def retrain():
    """Trigger model retraining in background thread"""
    try:
        # Check dataset availability first
        stats = get_dataset_stats()
        if stats['total'] < 10:
            return jsonify({
                'error': 'Insufficient data',
                'message': f'Need at least 10 samples, have {stats["total"]}',
                'dataset': stats,
            }), 400

        result = start_training()

        if result['status'] == 'already_training':
            return jsonify({
                'status': 'already_training',
                'message': 'Training is already in progress',
                'training_status': get_training_status(),
            }), 409

        return jsonify({
            'status': 'started',
            'version': result['version'],
            'dataset': stats,
            'message': 'Fine-tuning started in background',
        }), 202

    except Exception as e:
        logger.error(f'[ML_SERVICE] Retrain error: {str(e)}', exc_info=True)
        return jsonify({'error': 'Retrain failed', 'message': str(e)}), 500


@app.route('/api/v1/training/status', methods=['GET'])
def training_status():
    """Get current training progress"""
    try:
        status = get_training_status()
        dataset = get_dataset_stats()
        return jsonify({
            'training': status,
            'dataset': dataset,
        }), 200
    except Exception as e:
        logger.error(f'[ML_SERVICE] Training status error: {str(e)}')
        return jsonify({'error': str(e)}), 500


@app.errorhandler(404)
def not_found(error):
    return jsonify({
        'error': 'Not found',
        'message': 'Endpoint not found'
    }), 404


@app.errorhandler(500)
def internal_error(error):
    return jsonify({
        'error': 'Internal server error',
        'message': 'An error occurred during inference'
    }), 500


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))

    # Load models before starting server
    load_model_on_startup()

    logger.info(f'[ML_SERVICE] Starting ML service on port {port}')
    logger.info(f'[ML_SERVICE] Image model loaded: {_model_loaded}')
    logger.info(f'[ML_SERVICE] Audio model loaded: {is_audio_model_loaded()}')
    logger.info(f'[ML_SERVICE] Audio processing available: {is_audio_processing_available()}')
    logger.info(f'[ML_SERVICE] Using deepfake-detector-model-v1 (94.44% accuracy)')
    logger.info(f'[ML_SERVICE] Using wav2vec2-large-xlsr-deepfake-audio-classification (92.86% accuracy)')

    app.run(host='0.0.0.0', port=port, debug=False)
else:
    # Also load when imported as module (e.g., for testing)
    load_model_on_startup()
