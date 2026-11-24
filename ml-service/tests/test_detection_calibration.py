import unittest

from detection_calibration import aggregate_image_probability, extract_fake_probability


class DetectionCalibrationTests(unittest.TestCase):
    def test_fake_label_maps_directly(self):
        self.assertAlmostEqual(
            extract_fake_probability([{"label": "Fake", "score": 0.82}]),
            0.82,
        )

    def test_real_label_is_inverted(self):
        self.assertAlmostEqual(
            extract_fake_probability([{"label": "Real", "score": 0.91}]),
            0.09,
        )

    def test_numeric_label_is_mapped(self):
        self.assertAlmostEqual(
            extract_fake_probability([{"label": "LABEL_1", "score": 0.88}]),
            0.12,
        )

    def test_real_portrait_is_not_overridden_by_full_image_noise(self):
        result = aggregate_image_probability(
            full_probability=0.55,
            crop_probabilities=[0.08, 0.10, 0.11],
        )
        self.assertLess(result["risk_probability"], 0.20)

    def test_strong_full_canvas_synthetic_signal_is_kept(self):
        result = aggregate_image_probability(
            full_probability=0.82,
            crop_probabilities=[0.08, 0.09, 0.10],
        )
        self.assertGreaterEqual(result["risk_probability"], 0.82)

    def test_face_crop_manipulation_is_detected(self):
        result = aggregate_image_probability(
            full_probability=0.35,
            crop_probabilities=[0.35, 0.58, 0.72],
        )
        self.assertGreaterEqual(result["risk_probability"], 0.72)


if __name__ == "__main__":
    unittest.main()
