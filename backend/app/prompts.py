"""Prompt 模板。"""

RESUME_PARSE_PROMPT = """你是简历解析助手。请从下面的简历文本中抽取结构化信息，只返回 JSON（不要任何解释、不要 markdown 代码块）。

要求字段：
{{
  "name": "姓名",
  "title": "当前/目标职位头衔",
  "years_exp": 工作年限(数字,可小数),
  "skills": ["技能1", "技能2"],
  "experience": [{{"company": "公司", "role": "职位", "period": "起止时间", "achievements": ["成果1", "成果2"]}}],
  "education": [{{"school": "学校", "degree": "学历", "major": "专业", "period": "时间"}}],
  "summary": "一句话自我总结",
  "target_role": "目标岗位",
  "expected_salary": 期望月薪(单位K的数字,如15;简历没写就填0)
}}

简历文本：
{resume_text}
"""

EVALUATE_PROMPT = """你是资深招聘顾问。请评估候选人简历与目标岗位 JD 的匹配度。

简历（JSON）：
{resume}

岗位 JD：
{job}

请从「技能匹配、经验匹配、职级年限匹配、行业匹配、学历匹配」5 个维度打分（每项 0-100 整数），并给出综合分（0-100 整数）、匹配亮点、差距点。只返回 JSON（不要任何解释、不要 markdown 代码块）：

{{
  "overall_score": 80,
  "dimensions": [
    {{"name": "技能匹配", "score": 85, "comment": "一句话理由"}}
  ],
  "matched_points": ["匹配亮点1", "匹配亮点2"],
  "gaps": ["差距/风险点1", "差距点2"]
}}
"""

TAILOR_MESSAGE_PROMPT = """你是求职者本人。基于简历与岗位的匹配点，写一条 BOSS直聘风格的主动打招呼语（约 60-120 字），突出你与该岗位最契合的 2-3 点，语气自然、有信息量、不油腻。只返回 JSON（不要任何解释、不要 markdown 代码块）：

{{
  "tailored_message": "打招呼语内容"
}}

简历：
{resume}

岗位：
{job}

匹配评估：
{evaluation}
"""

RESUME_ADVICE_PROMPT = """你是简历优化专家。基于目标岗位 JD 和当前匹配评估，给出针对这份 JD 的具体、可执行的简历优化建议（例如：把某段经历改成 STAR + 量化、补上某关键词、突出某项目）。只返回 JSON（不要任何解释、不要 markdown 代码块）：

{{
  "resume_suggestions": ["建议1", "建议2", "建议3"]
}}

简历：
{resume}

岗位：
{job}

匹配评估：
{evaluation}
"""
