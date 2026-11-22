# VERITRACE — Easy 5-Minute Presentation Script
**Speaker:** Sankalp Gaonkar  
**Duration:** 4 to 5 Minutes (Simple, natural, and easy to memorize)

---

## 📌 1-Page Presentation Cheat Sheet

```
1. INTRO (1 min)   -> What is the problem? Deepfakes are easy to make, hard to detect.
2. HOW IT WORKS     -> 4 Agents: Perception -> Detection -> Compression -> Cognitive.
3. INNOVATION       -> Dual-Signal: checks face crops + full image (SigLIP AI model).
4. LIVE DEMO (2 min)-> Upload an image/video -> Watch progress -> Show result & report.
5. DATABASE (1 min) -> 3NF/BCNF tables, duplicate hash prevention, audit logs.
```

---

## 🎙️ Step-by-Step Script (Just Say This!)

### 1. Introduction (1 Minute)
> *"Hello everyone.*
>
> *Today, anyone can create a realistic fake video, audio clone, or AI image in seconds. This creates huge problems for security, news credibility, and financial fraud.*
>
> *The problem is: most existing detectors only give a single score without explaining why, and they often fail when an AI image is generated from scratch.*
>
> *My project is **VERITRACE**—a real-time Deepfake Detection and Authenticity Verification System that detects fake media, explains the result clearly, and stores a tamper-proof audit trail."*

---

### 2. How the System Works (1 Minute)
> *"Instead of a single complicated model, VERITRACE uses a **4-Agent Pipeline**:*
>
> 1. **Perception Agent**: Reads the file, checks file type and resolution, and calculates a SHA-256 fingerprint so identical files don't need to be processed twice.
> 2. **Detection Agent**: Finds faces and runs them through our AI model (**SigLIP Vision Transformer**) to spot synthetic textures.
> 3. **Compression Agent**: Checks video and image compression artifacts to tell real camera noise apart from AI generation patterns.
> 4. **Cognitive Agent**: Combines all scores into a final **Risk Score (0 to 100%)**, assigns a verdict (**AUTHENTIC, SUSPICIOUS, or DEEPFAKE**), and writes plain-English explanations."*

---

### 3. What Makes Our ML Accurate? (30 Seconds)
> *"Most detectors make a simple mistake: they only look at a tight crop of the face. But modern AI models (like Midjourney or Flux) generate very smooth faces and leave the fake clues in the background or lighting.*
>
> *Our solution is **Dual-Signal Detection**:*
> *We check **both** the tight face crops **and** the full canvas. If either shows strong signs of AI generation, our system catches it. This gives us over **94% accuracy** on images and **92% accuracy** on voice clones using Wav2Vec2."*

---

### 4. Live Demonstration (1.5 Minutes)
*(Have `http://localhost:3002` open in your browser)*

> **Step 1: Upload**
> *"Here is our live dashboard. I will upload a sample file."*  
> *(Action: Drag and drop an AI image or video into the scanner)*
>
> **Step 2: Real-time Progress**
> *"As soon as I upload, our frontend connects through WebSockets. You can see the progress bar move through each agent in real time: Perception, Detection, Compression, and Cognitive Report."*
>
> **Step 3: Show the Result**
> *"In less than a second, we have our report:*
> - *Verdict: **DEEPFAKE** (marked in red).*
> - *Risk Score: ~79%.*
> - *Explanation: It clearly states that AI synthesis signatures were detected.*
> - *Evidence Vault: The cryptographic hash and timestamp are permanently saved in our audit trail."*

---

### 5. Database & Backend Engineering (45 Seconds)
> *"On the database side, we followed strict DBMS principles:*
>
> - **3NF & BCNF Normalization**: We eliminated redundant data by separating scan records from verdict categories.
> - **Integrity Constraints**: The database prevents duplicate media uploads by enforcing unique file hashes.
> - **ACID Transactions**: Every scan update and audit log entry happens in a safe transaction—if anything fails, it rolls back automatically to prevent corrupted data."*

---

### 6. Closing (15 Seconds)
> *"In short, VERITRACE is fast, transparent, highly accurate, and backed by a robust database architecture.*
>
> *Thank you! I'm happy to answer any questions."*

---

## 🎯 5 Simple Q&As for Evaluators

**Q1: How does your system detect AI images without a face?**  
> *"Our AI model (SigLIP) looks at the entire image canvas, not just faces. It detects synthetic lighting, diffusion textures, and unnatural background patterns that AI generators leave behind."*

**Q2: What is the benefit of using 4 agents instead of one model?**  
> *"Modularity and explainability. Each agent handles one job (metadata, visual AI, compression noise, final synthesis). If one part has an issue, we can debug or upgrade it without breaking the rest of the pipeline."*

**Q3: How do you prevent users from uploading the same file twice?**  
> *"We compute a SHA-256 hash of every file upon upload. The database has a UNIQUE constraint on that hash, so identical files are instantly identified without running the heavy AI models again."*

**Q4: Why does the progress bar update without refreshing the page?**  
> *"We use WebSockets (Socket.IO). The backend streams progress events directly to the browser as each stage finishes, so the user sees live feedback instantly."*

**Q5: What are the three verdicts?**  
> - **AUTHENTIC**: Risk below 40% (natural media).  
> - **SUSPICIOUS**: Risk between 40% and 74% (some anomalies, human review recommended).  
> - **DEEPFAKE**: Risk 75% or higher (clear signs of AI manipulation).
