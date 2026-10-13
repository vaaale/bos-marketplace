On the Design of Qwen3.8-Next Architecture: Evaluation, Efficiency,
and Training Stability

2026-08-26

Qwen Team

Abstract

We describe the architecture and ablations of Qwen3.8-Flash-Next, a sparse mixture-
of-experts model with 125B parameters, 6B activated per token, and additional 51B
parameters of n-gram embedding tables held off the accelerator. On fourteen pre-training
benchmarks the model leads the 397B-A17B predecessor on eight and trails it on the rest
by at most 2.6 points, at 1/3 the activated parameters, 1/3 the training tokens, and roughly
1/9 the training FLOPs. Token mixing uses a layer-wise hybrid of Gated DeltaNet (GDN)
and global attention, with one full-attention layer in every four; at continued-pretraining
time those full-attention layers are replaced by Qwen Sparse Attention (QSA), which
scores context at micro-block granularity with a compressed lightweight indexer. The
residual stream is widened to four branches and read through an elementwise gate,
a design we call the Gated Residual (GR). Capacity is added outside the backbone
by a single n-gram embedding layer whose tables are prefetched from host memory.
We evaluate every candidate change along three axes: loss together with downstream
benchmarks; the cost of the change in training, prefill and decode; and its effect on the
optimal hyperparameters and training stability. Loss and downstream accuracy do not
always move together: enlarging the n-gram vocabulary lowers loss monotonically while
downstream accuracy saturates. The architecture and the Muon optimizer together shift
the optimal learning rate and batch size upwards, render batch-size warmup unnecessary,
and substantially improve stability under stress tests. Loss, benchmarks, efficiency and
stability form one design problem. Solved jointly, they yield a recipe that is simultaneously
more efficient, more capable and more stable.

1

Introduction

Qwen3.8-Flash-Next is a sparse mixture-of-experts model with 125B total parameters, 6B activated per
token, and additional 51B parameters of n-gram embedding tables held off the accelerator. The design goal
is to retain the quality of the previous generation’s 397B-A17B flagship (Qwen Team, 2026) at a fraction
of its compute budget. On fourteen pre-training benchmarks spanning knowledge, STEM, reasoning,
coding and multilingual ability, the resulting base model leads that predecessor on eight and trails it on
the remaining six by at most 2.6 points (Tab. 11), while activating roughly a third as many parameters
per token and training on roughly a third as many tokens, for about a ninth of the training FLOPs.

An architectural change touches three things at once: what the model can do on downstream tasks, what it
costs to train and to serve, and whether the training run remains optimal and stable at scale. We therefore
evaluate every candidate change along three axes: loss together with downstream benchmarks; the cost of
the change in training, prefill and decode; and its effect on the optimal hyperparameters and on training
stability. Loss, benchmarks, efficiency and stability form one design problem, and we report each on its
own terms. Throughout this report, we highlight where the three axes disagree and the design choices
those disagreements led to.

Four architectural components carry the design, each addressing a distinct bottleneck. Token mixing
uses a layer-wise hybrid of Gated DeltaNet (GDN) (Yang et al., 2024) and global attention: the recurrent
layers compress the prefix into a fixed-size state at linear cost, while one full-attention layer in every
four retains the direct token-level retrieval that no finite-state memory reproduces exactly (§2.1.1). At
continued-pretraining time those full-attention layers are replaced by Qwen Sparse Attention (QSA),
which follows the sparse-attention route of Liu et al. (2025a) but scores context at micro-block granularity
with a compressed lightweight indexer, so that the cost of indexing itself falls with sequence length. The
residual stream is widened to four branches (Baykal et al., 2023; Zhu et al., 2024) and read through an
elementwise gate, a design we call Gated Residual (GR) (§2.2): widening adds capacity to the residual
path, and the gate decides how that capacity is spent, while also supplying the rescaling that keeps training
stable. Capacity is further added outside the backbone by a single n-gram embedding layer (Google
DeepMind, 2025; Cheng et al., 2026) whose tables are prefetched from host memory (§2.3), scaling
parameter count with negligible additional per-token FLOPs and latency.

1

| MTP Modules | Prediction Head |     |     |
| ----------- | --------------- | --- | --- |
GR Read ○

qk-clip (Kimi Team, 2025) or SwiGLU-clip (Agarwal et al., 2025).

Organization. §2.1.1 and §2.1.2 describe token mixing. §2.2 covers the gated residual, §2.3 the n-gram
embedding layer, §3.1 the optimizer, §3.2 the hyperparameter scaling and §3.3 the stability stress test.
Evaluation of the resulting base and post-trained models follows.

2 Model Architecture

2.1 Attention

2.1.1 GDN Hybrid Architecture

Figure 2: The Gated DeltaNet token mixer. The projected query, key, and value streams pass through
short causal convolutions; queries and keys are L2-normalized before the gated delta recurrence. The
decay gate αt and write gate βt control the recurrent update, while a sigmoid output gate modulates the
zero-centered RMS-normalized output.

et al., 2021b) and GSM8K (Cobbe et al., 2021); reasoning results on BBH (Suzgun et al., 2023); multilingual
results on MMMLU (OpenAI, 2024); and code results on EvalPlus and on MultiPL-E (Cassano et al.,
2023). The results are reported in Table 1.
The GDN hybrid improves over the Transformer on eight of the nine selected benchmarks and exceeds
the SWA hybrid on seven. It achieves the best result on seven benchmarks and the highest overall average,
while the SWA hybrid is marginally higher on MMLU and stronger on EvalPlus.
2.1.2 Qwen Sparse Attention
Motivation. By selectively attending to important context, sparse attention alleviates the quadratic
computational bottleneck of softmax attention in long-context scenarios. Recently, DSA (Liu et al., 2025a)
has achieved considerable inference speedups using a lightweight indexer to generate token-level sparse
masks. However, as sequence length increases, the overhead of its O(n2) indexer remains non-negligible.

| --- | --- | --- | ------ | --- | ------- | --- | --- | --- |
Keep 4
|     |     |     |     | 82  | Stage 2 |     |     |     |
| --- | --- | --- | --- | --- | ------- | --- | --- | --- |
Block 8
| 82  |     |                   |     |     | Full Attention |     |     |     |
| --- | --- | ----------------- | --- | --- | -------------- | --- | --- | --- |
|     |     | Keep 3 IndexShare |     | 80  |                |     |     |     |
QSA
80 Block 16
|     |                           | Full Attention |     | 78  |                               |     |     |     |
| --- | ------------------------- | -------------- | --- | --- | ----------------------------- | --- | --- | --- |
|     | 0.1 0.2                   | 0.3 0.4        | 0.5 |     | 1                             | 2   | 4   | 16  |
|     | Relative indexer latency  |                |     |     | Number of indexer heads       |     |     |     |
|     | (a) Compression strategies. |                |     |     | (b) Indexer head configurations. |     |     |     |
Figure5: Architecture ablations of QSA on RULER. (a) QSA performance with different micro-block sizes;

achieves 7.6× and 4.9× attention-module speedups for prefill and decode, respectively, demonstrating its
scalability for long-context inference.
9

2.2 Residual
Residual connections give every block a direct path to the network output (He et al., 2016).
Motivation.
Pre-normalization keeps training stable at scale (Xiong et al., 2020), but it attenuates the signal each layer
receives: every block reads the same stream, so a feature written early must compete with everything

write of Eq. (33)–(34) are each fused into a single kernel, with the group RMSNorm folded into the read,
so the widened stream is traversed once per block in each direction.

2.3 N-gram Embedding

Motivation. Embedding-based memory offers a complementary dimension for scaling model capac-
ity (Google DeepMind, 2025; RWKV Community, 2025; Gemma Team, 2026; Liu et al., 2026; Sadhukhan
et al., 2026; Tseng & De Sa, 2026). N-gram embeddings further generalize unigram lookup by conditioning
memory retrieval on local context rather than token identity alone (Huang et al., 2021; Roy et al., 2022;
Huang et al., 2025; Yu et al., 2025; Cheng et al., 2026; Chen et al., 2026). Concretely, short n-grams ending
at each token serve as keys into embedding tables, and the retrieved vectors augment the corresponding
token representation. N-gram memory scales capacity with negligible additional per-token FLOPs, while
deterministic addressing enables host-memory offloading and asynchronous prefetching (Google Deep-
Mind, 2025; Cheng et al., 2026). In this section, we systematically study the key architectural choices for
N-gram embedding. We use 300 tokens per active parameter (TPP) throughout experiments.

2.3.1 Placement of the N-gram Embedding Layers

Table 7: Effect of N-gram embedding layer placement. The total number of N-gram embedding parameters
is fixed across all settings.


host-memory prefetching to overlap with the computation of the first layer.

2.3.2 N-gram Vocabulary Size

We further explore the effect of scaling the vocabulary size of N-gram embeddings.

Table 8: Effect of N-gram vocabulary scaling under a fixed total model parameter budget. Vocabulary

15

3 Optimization

3.1 Optimizer

Motivation. The matrix-based optimizer Muon (Jordan et al., 2024) computes the update direction for a
matrix parameter by orthogonalizing the momentum using Newton–Schulz (NS) iterations, and has been

overhead rather than arithmetic. We capture the whole step in a CUDA graph to remove this overhead.

3.2 Hyperparameter Scaling

Motivation. Choosing near-optimal hyperparameters is critical for efficient and stable model training.
In previous generations of Qwen models, we fitted scaling laws for key hyperparameters, such as the


| average over the faint per-step trace. |     |     |     | GR enables more stable training. |     |     |     |     |     |     |     |
| --------------------------------- | --- | --- | --- | ---------------------------- | --- | --- | --- | --- | --- | --- | --- |
3.3 Stability Stress Test
When a model scales to trillions of parameters and is trained on tens of trillions of tokens,
Motivation.
it enters a regime where stability challenges emerge that are entirely absent in smaller-scale experi-
ments (Chowdhery et al., 2023; Zhang et al., 2022; Dehghani et al., 2023; Qwen Team, 2026). Forexample,

throughout the network, consistent at every probed depth. This allows stable training without explicit
activation control such as qk-clip (Kimi Team, 2025) and SwiGLU-clip (Agarwal et al., 2025).
4 Evaluation
We evaluate Qwen3.8-Flash-Next-Base against a set of strong base models across a broad range of capabili-
ties, including general knowledge, reasoning, mathematics, scientific knowledge, coding, and multilingual
understanding. The evaluation covers 14 benchmarks:
• General Tasks: MMLU (Hendrycks et al., 2021a) (5-shot), MMLU-Pro (Wang et al., 2024) (5-

training and inference.

5 Conclusion

We have described the architecture of Qwen3.8-Flash-Next and the ablations that selected it. The resulting
model retains the quality of the previous generation’s 397B-A17B flagship while activating a third of the
parameters, training on a third of the tokens, and consuming roughly a ninth of the FLOPs.

The design reflects a conviction that architecture, efficiency, and optimization form one coupled system.
GR supplies a rescaling that markedly improves training stability, and that stability margin shifts the
optimal learning rate and batch size upward, improving both throughput and convergence. Phase-by-
phase cost accounting directed the sparse-attention design into the indexer and concentrated the gated
residual’s expressiveness on the read. Removing any axis from the loop would have admitted seemingly
harmless shortcuts: sparse writes that degrade after post-training, positional encoding that appears
dispensable during pre-training, or a batch-size warmup that costs extra optimizer steps for no gain.

Equally important is how these decisions were validated. Every claim was tested at a scale where the
full evaluation budget remains tractable, and the settings were designed to surface the failure modes
of production training: the stress test holds the learning rate at multiples of its optimal value so that
instabilities emerge within a moderate budget, and scaling-law predictions are verified at the regime
where each is most sensitive. Where pre-training metrics agreed but late-stage evaluation diverged,
the joint protocol caught the discrepancy before it reached production. Looking forward, the tightest
bottleneck is evaluation throughput: a cheaper mid-scale probe that reliably predicts post-training ordering
would make the design space far more searchable.

6 Authors

Core Contributors: Zihan Qiu, Zekun Wang, Xiao Li, Yanpeng Li, Yang Xu, Yixuan Wang, Huaqing
Zhang, Rui Men, Bo Zheng(cid:66), Dayiheng Liu(cid:66)

1: Bochao Mao, Chengruidong Zhang, Fan Zhou, Hao Luo, Haofeng Huang, Haoran Lian,
Contributors

