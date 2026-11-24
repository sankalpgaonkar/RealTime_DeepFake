"""Small, testable calibration helpers for deepfake model outputs."""


def normalize_label(label):
    if label is None:
        return ""
    return "".join(ch for ch in str(label).lower() if ch.isalnum())


def extract_fake_probability(result):
    """Convert Hugging Face image/audio labels into a fake probability."""
    items = result if isinstance(result, list) else [result]

    fake_score = None
    real_score = None

    for item in items:
        if not isinstance(item, dict):
            continue
        label = normalize_label(item.get("label"))
        score = float(item.get("score", 0.0))

        if any(token in label for token in ("fake", "deepfake", "spoof", "synthetic", "manipulated", "forged")) or label in ("label0", "0"):
            fake_score = score if fake_score is None else max(fake_score, score)
        elif any(token in label for token in ("real", "authentic", "bonafide", "genuine")) or label in ("label1", "1"):
            real_score = score if real_score is None else max(real_score, score)

    if fake_score is not None:
        return max(0.0, min(1.0, fake_score))
    if real_score is not None:
        return max(0.0, min(1.0, 1.0 - real_score))

    if items and isinstance(items[0], dict):
        top_label = normalize_label(items[0].get("label"))
        top_score = float(items[0].get("score", 0.5))
        if top_label in ("label0", "0"):
            return top_score
        if top_label in ("label1", "1"):
            return 1.0 - top_score

    return 0.5


def aggregate_image_probability(full_probability, crop_probabilities):
    """Fuse whole-image and face-crop model signals without letting one signal dominate."""
    full_probability = max(0.0, min(1.0, float(full_probability)))

    if not crop_probabilities:
        return {
            "risk_probability": full_probability,
            "peak_probability": full_probability,
            "mean_probability": full_probability,
        }

    crops = [max(0.0, min(1.0, float(value))) for value in crop_probabilities]
    crops_sorted = sorted(crops)
    crop_count = len(crops_sorted)
    crop_p90_index = min(crop_count - 1, int(round(0.9 * (crop_count - 1))))
    crop_p90 = crops_sorted[crop_p90_index]
    crop_max = max(crops_sorted)
    crop_mean = sum(crops_sorted) / crop_count

    if crop_max < 0.12:
        if full_probability >= 0.65:
            # Strong whole-canvas synthetic signal, even when the face crops look clean.
            risk_probability = full_probability
        else:
            # Real portrait: ignore low-confidence full-frame diffusion noise.
            risk_probability = (0.90 * crop_p90) + (0.10 * min(full_probability, 0.25))
    elif crop_p90 >= 0.40:
        risk_probability = max(crop_p90, full_probability)
    elif full_probability >= 0.65:
        risk_probability = max(full_probability, crop_p90)
    else:
        risk_probability = (0.60 * crop_p90) + (0.40 * full_probability)

    peak_probability = max(full_probability, crop_max, risk_probability)
    mean_probability = (crop_mean + full_probability) / 2.0

    return {
        "risk_probability": risk_probability,
        "peak_probability": peak_probability,
        "mean_probability": mean_probability,
    }
